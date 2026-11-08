#!/usr/bin/env bash
set -euo pipefail
container_name="$1"
result_dir="$(mktemp -d /tmp/lexora-quota-XXXXXX)"
trap 'rm -rf "$result_dir"' EXIT
docker exec -i "$container_name" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
insert into auth.users(id) values('30000000-0000-4000-8000-000000000003'),('40000000-0000-4000-8000-000000000004');
SQL
claim(){
 local caller="$1" key="$2" output_file="$3"
 docker exec "$container_name" psql -U postgres -Atq -v ON_ERROR_STOP=1 -c "set role authenticated; set request.jwt.claim.sub='$caller'; select public.claim_analysis('$key');" > "$output_file"
}
pids=()
for i in $(seq 1 24); do
 claim '30000000-0000-4000-8000-000000000003' "$(printf '%064x' "$i")" "$result_dir/quota-$i" &
 pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
ok_count="$(awk '$0=="ok"{n++}END{print n+0}' "$result_dir"/quota-*)"
limited_count="$(awk '$0=="limited"{n++}END{print n+0}' "$result_dir"/quota-*)"
if [[ "$ok_count" != 20 || "$limited_count" != 4 ]]; then
 echo "FAIL: concurrent quota expected 20 ok/4 limited; got $ok_count/$limited_count" >&2
 exit 1
fi
pids=()
for i in $(seq 1 8); do
 claim '40000000-0000-4000-8000-000000000004' "$(printf '%064x' 255)" "$result_dir/lease-$i" &
 pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
ok_count="$(awk '$0=="ok"{n++}END{print n+0}' "$result_dir"/lease-*)"
busy_count="$(awk '$0=="busy"{n++}END{print n+0}' "$result_dir"/lease-*)"
if [[ "$ok_count" != 1 || "$busy_count" != 7 ]]; then
 echo "FAIL: concurrent leases expected 1 ok/7 busy; got $ok_count/$busy_count" >&2
 exit 1
fi
echo 'PASS: 24 concurrent quota claims and 8 concurrent same-key lease claims'
