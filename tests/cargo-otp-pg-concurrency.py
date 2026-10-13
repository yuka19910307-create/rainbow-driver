#!/usr/bin/env python3
"""Run concurrent OTP claims ONLY in the disposable GitHub Actions PostgreSQL container.

No external network, Supabase credentials, Gmail, production DB or customer data.
"""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor

CONTAINER = "cargo-otp-ci-postgres"
OPERATOR = "11111111-1111-4111-8111-111111111111"
PREFIX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb"
CHALLENGE_PREFIX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa"
FINGERPRINT = "ab" * 32


def psql(sql: str, *, timeout: int = 25) -> str:
    proc = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres",
         "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql],
        text=True, capture_output=True, timeout=timeout, check=True,
    )
    return proc.stdout.strip()


def claim(digit: str) -> str:
    sql = f"""select public.cargo_operator_draft_otp_claim(
      '{OPERATOR}'::uuid,
      '{PREFIX}{digit}'::uuid,
      '{CHALLENGE_PREFIX}{digit}'::uuid,
      decode(repeat('{digit}{digit}',32),'hex'),
      decode('{FINGERPRINT}','hex')
    )::text;"""
    raw = psql(sql)
    data = json.loads(raw)
    return data["reason"]


def lock_and_sleep(digit: str, seconds: int):
    sql = f"""begin;
      select 1 from public.cargo_operator_draft_otp_bindings
       where draft_id='{PREFIX}{digit}'::uuid for update;
      select pg_sleep({seconds});
      commit;"""
    process = subprocess.Popen(
        ["docker", "exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres",
         "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=1,
    )
    # First output line comes from SELECT ... FOR UPDATE, so the row is locked.
    line = process.stdout.readline().strip()
    if line != "1":
        process.kill()
        raise AssertionError(f"Could not acquire row lock: {line!r}")
    return process


def release(holder):
    out, err = holder.communicate(timeout=20)
    if holder.returncode:
        raise AssertionError(f"Lock holder failed: {err} {out}")


def simultaneous_claims():
    holder = lock_and_sleep("6", 3)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(claim, "6")
            second = pool.submit(claim, "6")
            reasons = sorted([first.result(timeout=15), second.result(timeout=15)])
        release(holder)
        assert reasons == ["ALREADY_CLAIMED", "CLAIMED"], reasons
        stored = psql(
            f"select count(*) from public.cargo_operator_draft_otp_bindings "
            f"where draft_id='{PREFIX}6'::uuid and claimed_at is not null"
        )
        assert stored == "1", stored
        print("PASS: concurrent claims yield exactly one success and one replay rejection")
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.communicate()


def expiration_while_waiting():
    # Draft 4 was not claimed in the initial SQL assertions.
    # Both expiry values are shortened in the disposable DB only.
    psql(f"""update public.cargo_operator_draft_otp_bindings
      set expires_at=clock_timestamp()+interval '2 seconds'
      where draft_id='{PREFIX}4'::uuid;
      update public.cargo_email_verification_challenges
      set expires_at=clock_timestamp()+interval '2 seconds'
      where id='{CHALLENGE_PREFIX}4'::uuid;""")
    holder = lock_and_sleep("4", 4)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(claim, "4")
            reason = waiting.result(timeout=15)
        release(holder)
        assert reason == "EXPIRED", reason
        stored = psql(
            f"select count(*) from public.cargo_operator_draft_otp_bindings "
            f"where draft_id='{PREFIX}4'::uuid and claimed_at is not null"
        )
        assert stored == "0", stored
        print("PASS: code expiring while waiting for a row lock cannot be claimed")
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.communicate()


if __name__ == "__main__":
    simultaneous_claims()
    expiration_while_waiting()
