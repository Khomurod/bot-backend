/**
 * Which kind of database failure is this?
 *
 * The whole point is to tell an admin the TRUE thing: an unreachable database,
 * an exhausted usage allowance, a rejected credential and an application bug
 * each need a different response, and until now they all arrived as one opaque
 * 500 — or, on several endpoints, as an empty list that looked like "no data".
 *
 * The tests are grouped by the answer the admin gets, and the last group is the
 * important one: an ordinary SQL error must NOT be dressed up as an outage, or
 * the warning stops meaning anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FAILURE_CODES, classifyDatabaseError, isDatabaseFailure,
} = require('../lib/database/failureClassification');

/** A pg error carries its SQLSTATE on `code`. */
const pgError = (message, code) => Object.assign(new Error(message), { code });

test('a lost or refused connection is DB_UNAVAILABLE', () => {
  const cases = [
    pgError('Connection terminated unexpectedly', undefined),
    pgError('terminating connection due to administrator command', '57P01'),
    pgError('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    pgError('getaddrinfo ENOTFOUND db.project.supabase.co', 'ENOTFOUND'),
    pgError('Client has encountered a connection error and is not queryable', undefined),
    pgError('server closed the connection unexpectedly', '08006'),
    pgError('database "app" does not exist', '3D000'),
  ];
  for (const error of cases) {
    const failure = classifyDatabaseError(error);
    assert.equal(failure?.code, FAILURE_CODES.DB_UNAVAILABLE, error.message);
    assert.equal(failure.status, 503);
    assert.equal(failure.retryable, true);
  }
});

test('exhausted connections and timeouts are DB_TIMEOUT, and retryable', () => {
  const cases = [
    pgError('sorry, too many clients already', undefined),
    pgError('too many connections for role "app"', '53300'),
    pgError('remaining connection slots are reserved', undefined),
    pgError('timeout exceeded when trying to connect', undefined),
    pgError('canceling statement due to statement timeout', '57014'),
    pgError('deadlock detected', '40P01'),
  ];
  for (const error of cases) {
    const failure = classifyDatabaseError(error);
    assert.equal(failure?.code, FAILURE_CODES.DB_TIMEOUT, error.message);
    assert.equal(failure.retryable, true);
  }
});

test('a usage ceiling is DB_QUOTA — a limit, not a fault', () => {
  const cases = [
    pgError('monthly data transfer quota exceeded', undefined),
    pgError('egress limit reached for this project', undefined),
    pgError('project is paused', undefined),
    pgError('could not extend file: No space left on device', '53100'),
    pgError('out of memory', '53200'),
  ];
  for (const error of cases) {
    const failure = classifyDatabaseError(error);
    assert.equal(failure?.code, FAILURE_CODES.DB_QUOTA, error.message);
    assert.equal(failure.status, 503);
    // Retrying a hard limit immediately is pointless and adds load.
    assert.equal(failure.retryable, false);
  }
});

test('rejected credentials or privileges are DB_PERMISSION', () => {
  for (const error of [
    pgError('password authentication failed for user "app"', '28P01'),
    pgError('permission denied for table trailers', '42501'),
  ]) {
    assert.equal(classifyDatabaseError(error)?.code, FAILURE_CODES.DB_PERMISSION, error.message);
  }
});

test('an application bug is NOT reported as a database failure', () => {
  // If a typo or a constraint violation claimed the database was down, someone
  // would go and check the provider status page over their own SQL.
  const notInfrastructure = [
    pgError('duplicate key value violates unique constraint "trailers_unit_key"', '23505'),
    pgError('null value in column "unit_number" violates not-null constraint', '23502'),
    pgError('syntax error at or near "SELCT"', '42601'),
    pgError('column "nope" does not exist', '42703'),
    pgError('invalid input syntax for type integer: "abc"', '22P02'),
    new Error('Cannot read properties of undefined'),
  ];
  for (const error of notInfrastructure) {
    assert.equal(classifyDatabaseError(error), null, error.message);
    assert.equal(isDatabaseFailure(error), false, error.message);
  }
});

test('nothing at all classifies as nothing', () => {
  assert.equal(classifyDatabaseError(null), null);
  assert.equal(classifyDatabaseError(undefined), null);
  assert.equal(isDatabaseFailure(null), false);
});

test('every failure carries a human sentence and a 503', () => {
  const failure = classifyDatabaseError(pgError('Connection terminated unexpectedly'));
  assert.match(failure.message, /database could not be reached/i);
  assert.equal(failure.status, 503);
  // The message must be safe to show: no host names, no credentials, no SQL.
  assert.doesNotMatch(failure.message, /postgres|supabase|password|@/i);
});
