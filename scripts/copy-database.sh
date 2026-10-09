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
# The restore is ONE transaction. It lands whole or not at all, so a failed
# run leaves the target empty and can simply be run again.
#
# The repository is public, and so is the Actions log. Nothing here prints a
# row, a row count, a size, or any part of a connection string: tables whose
# rows differ are named, and their counts are not shown.
#
# Needs the PostgreSQL client tools of the servers' major version or newer.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

# GitHub masks a secret's whole value, not its parts, and the addresses are
# rewritten below. Mask every piece that could identify or open the database.
hide() {
  if [ "${GITHUB_ACTIONS:-}" = true ] && [ -n "$1" ]; then echo "::add-mask::$1"; fi
}

# Sets the variable named $2 to the address in $1, made safe to connect with:
# session pooling, and encryption required.
prepare_url() {
  local name="$1" url="${!1:-}" host port
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

# ── Copy ────────────────────────────────────────────────────────────────────
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Reading the source…"
pg_dump --dbname="$OLD" --schema=public --format=custom --no-owner --no-privileges --file="$work/db.dump"

# Every database already has a public schema; restoring its CREATE would fail.
pg_restore --list "$work/db.dump" \
  | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' > "$work/restore.list"
pg_restore --use-list="$work/restore.list" --no-owner --no-privileges --file="$work/restore.sql" "$work/db.dump"

echo "Writing the target, in one transaction…"
# The script's own output is dropped: its setval() results are sequence
# positions, which say how many rows were ever written. Errors still show, terse
# and without context, because a failing COPY would otherwise quote its row.
psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never --single-transaction \
  -d "$NEW" "${create_extensions[@]}" -f "$work/restore.sql" > /dev/null \
  || fail "Writing the target failed, so none of it was kept: the target is still empty. The error is above."

psql -X -q -v ON_ERROR_STOP=1 -d "$NEW" <<'SQL'
SELECT format('ANALYZE public.%I', relname)
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
\gexec
SQL

# ── Verify ──────────────────────────────────────────────────────────────────
SHAPE="SELECT concat_ws(', ',
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')) || ' tables',
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('i','I')) || ' indexes',
  (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('p','u','f','c','x')) || ' constraints',
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S') || ' sequences',
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('v','m')) || ' views',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') || ' policies')"
SECURED="SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relrowsecurity"
ROWS="SELECT relname || ' ' || (xpath('/row/n/text()',
  query_to_xml(format('SELECT count(*) AS n FROM public.%I', relname), false, true, '')))[1]::text
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') ORDER BY 1"
SEQUENCES="SELECT sequencename || ' ' || coalesce(last_value::text, '-')
  FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1"

old_shape="$(q "$OLD" "$SHAPE")"
new_shape="$(q "$NEW" "$SHAPE")"
old_secured="$(q "$OLD" "$SECURED")"
new_secured="$(q "$NEW" "$SECURED")"
echo "Source: $old_shape; row security on $old_secured tables."
echo "Target: $new_shape; row security on $new_secured tables."

# Names whose value differs, or that exist on one side only.
differing() {
  awk 'NR == FNR { a[$1] = $2; next }
       { if (!($1 in a) || a[$1] != $2) print $1; delete a[$1] }
       END { for (k in a) print k }' "$1" "$2" | sort -u
}
q "$OLD" "$ROWS" > "$work/old.rows"
q "$NEW" "$ROWS" > "$work/new.rows"
q "$OLD" "$SEQUENCES" > "$work/old.sequences"
q "$NEW" "$SEQUENCES" > "$work/new.sequences"
rows_differ="$(differing "$work/old.rows" "$work/new.rows")"
sequences_differ="$(differing "$work/old.sequences" "$work/new.sequences")"

ok=true
[ "$old_shape" = "$new_shape" ] || { echo "::error::The target's structure differs from the source's."; ok=false; }
# A host may switch row security on for every new table (Supabase can). That
# restricts no one connecting as the tables' owner, which is what the restore
# made the target's user. Fewer tables secured than before would be a loss.
if (( new_secured < old_secured )); then
  echo "::error::Row security is on for fewer tables in the target."
  ok=false
elif (( new_secured > old_secured )); then
  echo "::notice::The target switched row security on for more tables than the source has it on. Its owner, the user this copy wrote with, is not restricted by it."
fi
if [ -n "$rows_differ" ]; then
  echo "::error::Row counts differ in: $(echo "$rows_differ" | paste -sd ' ' -)"
  ok=false
else
  echo "Row counts: the same in all $(wc -l < "$work/old.rows") tables."
fi
if [ -n "$sequences_differ" ]; then
  echo "::error::Sequence positions differ in: $(echo "$sequences_differ" | paste -sd ' ' -)"
  ok=false
else
  echo "Sequence positions: the same in all $(wc -l < "$work/old.sequences") sequences."
fi
$ok || fail "The copy was written but does not match the source. If something wrote to the source during the copy, that explains it."
echo "Done. The source was only read; the target now holds the copy."
