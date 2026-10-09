#!/usr/bin/env bash
# Copy this application's database into another, EMPTY PostgreSQL database.
#
# Written in October 2026 to move off a hosted project whose monthly transfer
# allowance was spent, onto a fresh one. Run by the manual workflow
# .github/workflows/copy-database.yml; see docs/database/README.md.
#
#   OLD_DATABASE_URL  the source. Only read.
#   NEW_DATABASE_URL  the target. Written only when its `public` schema holds no
#                     table, view or sequence; otherwise nothing is written.
#
# WHAT IS COPIED: the `public` schema whole — every table and its rows, the
# sequences and where they stand, indexes, constraints, the view, row-level
# security and its policies — plus the extensions installed INTO `public`.
# That is all of the application's state. Every other schema in a hosted
# database belongs to the host, and the production one had nothing of ours
# there (checked: no auth users, no storage objects, no scheduled jobs).
#
# HOW IT IS CHECKED. A snapshot — a hash of every row of every table, every
# sequence's position, and the structure — is taken of the source before and
# after it is read. If they differ, something wrote to it meanwhile, and the
# copy stops before writing anything. The same snapshot is taken of the target
# INSIDE the restore's one transaction, which commits only if it matches. So a
# run either leaves an exact copy, or leaves the target empty and can simply
# be run again. Rows are hashed where they are: only the hashes cross the
# network.
#
# The repository is public, and so is the Actions log. Nothing here prints a
# row, a row count, a size, or any part of a connection string: what differs
# is named, never counted.
#
# Needs the PostgreSQL client tools of the servers' major version or newer.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

# GitHub masks a secret's whole value, not its parts, and the addresses are
# rewritten below. Mask every piece that could identify or open the database,
# including the server's name and addresses, which a connection error quotes.
hide() {
  if [ "${GITHUB_ACTIONS:-}" = true ] && [ -n "$1" ]; then echo "::add-mask::$1"; fi
}

# Sets the variable named $2 to the address in $1, made safe to connect with:
# session pooling, and encryption required.
prepare_url() {
  local name="$1" url="${!1:-}" host port ip
  [ -n "$url" ] || fail "$name is not set."
  hide "$url"
  case "$url" in
    *'[YOUR-PASSWORD]'*) fail "$name still says [YOUR-PASSWORD]: put the database password in its place." ;;
  esac
  [[ "$url" =~ ^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^/:?]+)(:([0-9]+))?/ ]] \
    || fail "$name is not a postgresql:// address."
  hide "${BASH_REMATCH[2]}"
  hide "${BASH_REMATCH[4]}"
  host="${BASH_REMATCH[5]}"
  port="${BASH_REMATCH[7]}"
  hide "$host"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    for ip in $(getent ahosts "$host" | awk '{ print $1 }' | sort -u); do hide "$ip"; done
  fi
  if [[ "$host" == db.*.supabase.co ]]; then
    fail "$name is Supabase's direct address, which GitHub cannot reach. Use Connect → Session pooler."
  fi
  # The transaction pooler hands each statement to any server connection; a
  # dump and a one-transaction restore need one connection throughout.
  if [[ "$host" == *.pooler.supabase.com && "$port" == 6543 ]]; then
    url="${url/:6543\//:5432/}"
  fi
  # libpq refuses query parameters it does not know, and an application's
  # address can carry its driver's own (pgbouncer=true, connection_limit=…).
  # Keep only sslmode, and require encryption unless the address says otherwise.
  local sslmode=require
  if [[ "$url" =~ [?\&]sslmode=([a-z-]+) ]]; then sslmode="${BASH_REMATCH[1]}"; fi
  url="${url%%\?*}?sslmode=$sslmode"
  hide "$url"
  printf -v "$2" '%s' "$url"
}

prepare_url OLD_DATABASE_URL OLD
prepare_url NEW_DATABASE_URL NEW
[ "$OLD" != "$NEW" ] || fail "OLD_DATABASE_URL and NEW_DATABASE_URL are the same database."

q() { psql -X -A -t -q -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
identifier() { [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || fail "Unexpected name in the source catalog."; }

# ── The snapshot ────────────────────────────────────────────────────────────
# One line per table ("table:<name> <md5 over the sorted md5s of its rows>"),
# one per sequence ("sequence:<name> <position>"), and one for the structure.
# Every setting that changes how a value is written as text is fixed first, so
# the same rows give the same hash on any server.
SETTINGS="SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres';
SET extra_float_digits = 1; SET bytea_output = 'hex'; SET statement_timeout = 0;"
SNAPSHOT="$(cat <<'SQL'
SELECT line FROM (
  SELECT 'table:' || c.relname || ' ' || (pg_catalog.xpath('/row/h/text()', pg_catalog.query_to_xml(pg_catalog.format(
           'SELECT md5(coalesce(string_agg(r, '','' ORDER BY r COLLATE "C"), '''')) AS h'
           ' FROM (SELECT md5(t::text) AS r FROM public.%I AS t) AS s', c.relname),
         false, true, '')))[1]::text AS line
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'sequence:' || sequencename || ' ' || coalesce(last_value::text, '-')
    FROM pg_catalog.pg_sequences WHERE schemaname = 'public'
  UNION ALL
  SELECT '(structure) ' || concat_ws(',',
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')) || '-tables',
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('i','I')) || '-indexes',
    (SELECT count(*) FROM pg_catalog.pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('p','u','f','c','x')) || '-constraints',
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S') || '-sequences',
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('v','m')) || '-views',
    (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public') || '-policies')
) AS snapshot ORDER BY line COLLATE "C"
SQL
)"
SECURED="SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relrowsecurity"
snapshot() { psql -X -A -t -q -v ON_ERROR_STOP=1 -d "$1" -c "$SETTINGS" -c "$SNAPSHOT"; }

# ── Before writing anything ─────────────────────────────────────────────────
old_version="$(q "$OLD" 'SHOW server_version_num')"
new_version="$(q "$NEW" 'SHOW server_version_num')"
[[ "$(pg_dump --version)" =~ ([0-9]+)\. ]] || fail "Cannot tell which pg_dump this is."
tools="${BASH_REMATCH[1]}"
echo "PostgreSQL: source $((old_version / 10000)), target $((new_version / 10000)), tools $tools."
(( old_version / 10000 <= tools )) || fail "pg_dump $tools cannot read a newer server."
(( new_version / 10000 >= old_version / 10000 )) || fail "The target runs an older PostgreSQL than the source."

RELATIONS="SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','S','f')"
[ "$(q "$OLD" "$RELATIONS")" != 0 ] || fail "The source has nothing in public. Is OLD_DATABASE_URL the right database?"
[ "$(q "$NEW" "$RELATIONS")" = 0 ] \
  || fail "The target already has tables in public. Nothing was written: this copies only into an EMPTY database."

found="$(q "$OLD" "SELECT extname FROM pg_extension WHERE extnamespace = 'public'::regnamespace ORDER BY 1")"
extensions=()
[ -z "$found" ] || mapfile -t extensions <<< "$found"
create_extensions=()
for ext in "${extensions[@]}"; do
  identifier "$ext"
  [ "$(q "$NEW" "SELECT count(*) FROM pg_available_extensions WHERE name = '$ext'")" = 1 ] \
    || fail "The target cannot install the extension $ext."
  create_extensions+=(-c "CREATE EXTENSION IF NOT EXISTS \"$ext\" WITH SCHEMA public")
done

found="$(q "$OLD" "SELECT DISTINCT r FROM pg_policies, unnest(roles) r WHERE schemaname = 'public' AND r <> 'public' ORDER BY 1")"
roles=()
[ -z "$found" ] || mapfile -t roles <<< "$found"
for role in "${roles[@]}"; do
  identifier "$role"
  [ "$(q "$NEW" "SELECT count(*) FROM pg_roles WHERE rolname = '$role'")" = 1 ] \
    || fail "The role $role, named by a row-level security policy, does not exist on the target."
done

# ── Read the source, and make sure nothing changed while it was read ────────
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Reading the source…"
snapshot "$OLD" > "$work/before"
pg_dump --dbname="$OLD" --schema=public --format=custom --no-owner --no-privileges --file="$work/db.dump"
snapshot "$OLD" > "$work/after"
cmp -s "$work/before" "$work/after" \
  || fail "Something wrote to the source while it was being read. Nothing was written. Stop everything that writes to it, then run again."
grep -qvE '^(table|sequence):[A-Za-z0-9_-]+ [0-9a-f-]+$|^\(structure\) [0-9a-z,-]+$' "$work/after" \
  && fail "Unexpected line in the source's snapshot."
old_secured="$(q "$OLD" "$SECURED")"
[[ "$old_secured" =~ ^[0-9]+$ ]] || fail "Unexpected answer from the source."

# Every database already has a public schema; restoring its CREATE would fail.
pg_restore --list "$work/db.dump" \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$work/restore.list"
pg_restore --use-list="$work/restore.list" --no-owner --no-privileges --file="$work/restore.sql" "$work/db.dump"
# Tools from 17 on set transaction_timeout, which an older target does not know.
if (( new_version / 10000 < 17 )); then sed -i '/^SET transaction_timeout = 0;$/d' "$work/restore.sql"; fi

# Run last in the restore's transaction: the target's snapshot must equal the
# source's, or the whole copy is rolled back.
{
  echo "$SETTINGS"
  echo 'CREATE TEMP TABLE copy_expected (line text) ON COMMIT DROP;'
  echo 'COPY copy_expected (line) FROM STDIN;'
  cat "$work/after"
  echo '\.'
  echo "CREATE TEMP TABLE copy_found ON COMMIT DROP AS $SNAPSHOT;"
  cat <<SQL
DO \$verify\$
DECLARE differing text;
BEGIN
  SELECT string_agg(DISTINCT split_part(line, ' ', 1), ' ') INTO differing FROM (
    (SELECT line FROM copy_expected EXCEPT SELECT line FROM copy_found)
    UNION ALL
    (SELECT line FROM copy_found EXCEPT SELECT line FROM copy_expected)) AS d;
  IF differing IS NOT NULL THEN
    RAISE EXCEPTION 'The copy does not match the source in: %', differing;
  END IF;
  IF ($SECURED) < $old_secured THEN
    RAISE EXCEPTION 'Row security is on for fewer tables in the copy than in the source.';
  END IF;
END
\$verify\$;
SQL
} > "$work/verify.sql"

# ── Write the target ────────────────────────────────────────────────────────
echo "Writing the target, in one transaction…"
# The script's own output is dropped: its setval() results are sequence
# positions, which say how many rows were ever written. Errors still show, terse
# and without context, because a failing COPY would otherwise quote its row.
psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never --single-transaction \
  -d "$NEW" "${create_extensions[@]}" -f "$work/restore.sql" -f "$work/verify.sql" > /dev/null \
  || fail "Writing or checking the target failed, so none of it was kept: the target is still empty. The error is above."

# The copy is committed. Nothing below may fail the run: the target is no
# longer empty, so a second run would be refused.
psql -X -q -v ON_ERROR_STOP=1 -d "$NEW" <<'SQL' \
  || echo "::warning::ANALYZE did not finish. The database gathers the statistics on its own; the copy is complete."
SELECT format('ANALYZE public.%I', relname)
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
\gexec
SQL

structure="$(sed -n -e 's/^(structure) //' -e 's/-/ /g' -e 's/,/, /gp' "$work/after")"
echo "The copy matches the source: every row of $(grep -c '^table:' "$work/after") tables," \
  "every sequence position, and the structure ($structure)."
new_secured="$(q "$NEW" "$SECURED" || echo "$old_secured")"
# A host may switch row security on for every new table (Supabase can). That
# restricts no one connecting as the tables' owner: the user this copy wrote
# with, which is the user the applications connect as.
if (( new_secured > old_secured )); then
  echo "::notice::The target switched row security on for more tables ($new_secured) than the source had it on ($old_secured). The tables' owner, the user this copy wrote with, is not restricted by it."
fi
echo "Done. The source was only read."
