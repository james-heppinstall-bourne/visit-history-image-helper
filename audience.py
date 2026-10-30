"""Who an email goes to, and what it did afterwards. Read-only.

Every account lands in exactly one segment:

  subscribers   has access now and is paying for it, or has been given it:
                Stripe, a verified store row, the store mirror, a paid group,
                or a lifetime / complimentary flag
  trial         on a free week now, and not paying
  lapsed-paid   paid at some point, has no access now
  lapsed-trial  never paid, free week over

chosen the way the website's `get_my_entitlement()` chooses (the live body is
`E:/code/VisitHistory/supabase_migration_group_entitlement.sql`). That
function reads `auth.uid()`, so it cannot be asked about somebody else, and
its precedence is restated here instead. Change one and the other must follow.

This is deliberately not `Api._merged_subscriptions`, which answers a
different question ("has this person ever subscribed, and through what") and
counts anyone active in any source as active. An email needs the one answer
the website would give that person today.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

SEGMENTS = ("subscribers", "trial", "lapsed-paid", "lapsed-trial")

STRIPE_ENTITLING = ("active", "trialing", "past_due")
STORE_ENTITLING = ("active", "grace", "cancelled")

# Accounts that are not a person: the App Store review login and test sign-ups.
# Some are exempt, so they would otherwise count as subscribers.
NOT_A_PERSON = re.compile(r"@(test\.com|appstore\.com|example\.(com|org)|mail-tester\.com)$")


def _fetch_all(client, table, columns, apply=None):
    rows, offset = [], 0
    while True:
        query = client.table(table).select(columns)
        if apply is not None:
            query = apply(query)
        batch = query.range(offset, offset + 999).execute().data or []
        rows.extend(batch)
        if len(batch) < 1000:
            return rows
        offset += 1000


def _attr(obj, name, default=None):
    value = getattr(obj, name, None) if not isinstance(obj, dict) else obj.get(name)
    return default if value is None else value


def _list_users(client):
    users, page = [], 1
    while True:
        res = client.auth.admin.list_users(page=page, per_page=1000)
        batch = res if isinstance(res, list) else getattr(res, "users", res)
        if not batch:
            return users
        for u in batch:
            created = _attr(u, "created_at", "")
            users.append({
                "id": str(_attr(u, "id")),
                "email": (_attr(u, "email", "") or "").strip().lower(),
                "created_at": created.isoformat() if hasattr(created, "isoformat") else str(created),
                "app_metadata": _attr(u, "app_metadata", {}) or {},
            })
        if len(batch) < 1000:
            return users
        page += 1


def _when(value):
    """A timestamp from the database or the auth API, as an aware datetime."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    # Postgres can return 5 fractional digits, which fromisoformat rejects
    # before Python 3.11; pad or trim to six.
    text = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], text, count=1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _truthy(value):
    # Typed by hand in the SQL editor, so compared as text, as the function does.
    return str(value if value is not None else "").lower() in ("true", "t", "1")


def _by_user(rows):
    out = {}
    for row in rows:
        out.setdefault(row.get("user_id"), []).append(row)
    return out


def _pick(rows, entitling, end_key):
    """The function's `order by <entitling> desc, <end> desc nulls last limit 1`."""
    if not rows:
        return None
    floor = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(
        rows,
        key=lambda r: (entitling(r), _when(r.get(end_key)) or floor),
        reverse=True,
    )[0]


def classify(client):
    """Every account with its segment, the reason, and whether it is an admin."""
    now = datetime.now(timezone.utc)
    users = _list_users(client)
    stripe_by = _by_user(_fetch_all(
        client, "stripe_subscriptions", "user_id, status, current_period_end",
        lambda q: q.eq("livemode", True)))
    store_by = _by_user(_fetch_all(
        client, "store_subscriptions", "user_id, status, expires_at",
        lambda q: q.eq("environment", "production")))
    mirror_by = {r["user_id"]: r for r in _fetch_all(
        client, "subscriptions", "user_id, is_subscribed, expires_at, first_subscribed_at")}
    override_by = {r["user_id"]: r for r in _fetch_all(
        client, "trial_overrides", "user_id, trial_start, trial_days")}
    members_by = _by_user(_fetch_all(
        client, "group_members", "user_id, groups(paid_until)"))

    out = []
    for u in users:
        meta = u["app_metadata"]
        admin = _truthy(meta.get("is_admin"))
        stripe = _pick(stripe_by.get(u["id"]),
                       lambda s: s.get("status") in STRIPE_ENTITLING, "current_period_end")
        store = _pick(store_by.get(u["id"]),
                      lambda s: s.get("status") in STORE_ENTITLING, "expires_at")
        mirror = mirror_by.get(u["id"])
        paid_once = bool((mirror and mirror.get("first_subscribed_at")) or stripe or store)

        def future(value):
            when = _when(value)
            return when is not None and when > now

        reason, segment = None, "subscribers"
        if admin or _truthy(meta.get("subscription_exempt")) or _truthy(meta.get("lifetime_subscription")):
            reason = "exempt"
        elif stripe and stripe.get("status") in STRIPE_ENTITLING:
            reason = "stripe"
        elif store and store.get("status") in STORE_ENTITLING and future(store.get("expires_at")):
            reason = "store"
        # The mirror only where there is no verified row, and lenient about a
        # null expiry, because the app sends null on purpose.
        elif not store and mirror and mirror.get("is_subscribed") and (
                not mirror.get("expires_at") or future(mirror["expires_at"])):
            reason = "mirror"
        elif any(future((m.get("groups") or {}).get("paid_until")) for m in members_by.get(u["id"], [])):
            reason = "group"

        trial_left = None
        if reason is None:
            # get_trial_days_remaining(): days less whole days elapsed, from the
            # override's start if there is one, else the account's creation.
            o = override_by.get(u["id"]) or {}
            start = _when(o.get("trial_start")) or _when(u["created_at"]) or now
            days = o.get("trial_days") if o.get("trial_days") is not None else 7
            left = days - (now - start).days
            if left > 0:
                reason, segment, trial_left = "trial", "trial", left
            else:
                reason, segment = "none", "lapsed-paid" if paid_once else "lapsed-trial"

        out.append({
            "id": u["id"], "email": u["email"], "segment": segment,
            "reason": reason, "admin": admin, "trial_days_left": trial_left,
            "test": bool(NOT_A_PERSON.search(u["email"])),
        })
    return out


def audience(client, include_admins=False):
    """Addresses per segment, with admins and test accounts taken off."""
    segments = {s: [] for s in SEGMENTS}
    reasons = {s: {} for s in SEGMENTS}
    left_out = {"admin": 0, "test": 0, "no_address": 0}
    for row in classify(client):
        if row["admin"] and not include_admins:
            left_out["admin"] += 1
            continue
        if not row["email"]:
            left_out["no_address"] += 1
            continue
        if row["test"]:
            left_out["test"] += 1
            continue
        segments[row["segment"]].append(row["email"])
        counts = reasons[row["segment"]]
        counts[row["reason"]] = counts.get(row["reason"], 0) + 1
    for addresses in segments.values():
        addresses.sort()
    return {"segments": segments, "reasons": reasons, "left_out": left_out,
            "read_at": datetime.now(timezone.utc).isoformat()}


def campaign_read(client, emails, since, until=None):
    """What a set of addresses did in a window: the measurement for a send.

    `until` makes it a baseline: the same people over the fortnight before a
    send. web_logs prunes info rows at 14 days, so a map-open count older than
    that is a floor rather than a count.
    """
    wanted = {e.strip().lower() for e in emails if e and "@" in e}
    wanted = {e for e in wanted if not NOT_A_PERSON.search(e)}
    users = {u["email"]: u for u in _list_users(client) if u["email"]}
    ids = [users[e]["id"] for e in wanted if e in users]
    since_at = _when(since)
    until_at = _when(until) if until else None

    def window(query):
        query = query.gte("created_at", since_at.isoformat())
        return query.lt("created_at", until_at.isoformat()) if until_at else query

    def users_with(table, column="user_id", apply=None):
        hit = set()
        for i in range(0, len(ids), 100):
            query = client.table(table).select(column).in_(column, ids[i:i + 100])
            if apply is not None:
                query = apply(query)
            offset = 0
            while True:
                rows = query.range(offset, offset + 999).execute().data or []
                hit.update(r[column] for r in rows if r.get(column))
                if len(rows) < 1000:
                    break
                offset += 1000
        return hit

    in_window = lambda d: bool(d) and since_at <= _when(d) and (until_at is None or _when(d) < until_at)
    started = set()
    for r in _fetch_all(client, "subscriptions", "user_id, first_subscribed_at"):
        if r["user_id"] in ids and in_window(r.get("first_subscribed_at")):
            started.add(r["user_id"])
    for r in _fetch_all(client, "stripe_subscriptions", "user_id, first_subscribed_at",
                        lambda q: q.eq("livemode", True)):
        if r["user_id"] in ids and in_window(r.get("first_subscribed_at")):
            started.add(r["user_id"])
    for r in _fetch_all(client, "stripe_payments", "user_id, created_at",
                        lambda q: q.eq("kind", "lifetime").eq("status", "paid")):
        if r["user_id"] in ids and in_window(r.get("created_at")):
            started.add(r["user_id"])

    now = datetime.now(timezone.utc)
    oldest_log = now - timedelta(days=14)
    return {
        "addresses": len(wanted),
        "matched": len(ids),
        "since": since_at.isoformat(),
        "until": until_at.isoformat() if until_at else None,
        "map_opened": len(users_with("web_logs", apply=lambda q: window(q.ilike("message", "map opened%")))),
        "map_opened_is_floor": since_at < oldest_log,
        "recorded_visit": len(users_with("visits", apply=window)),
        "made_layer": len(users_with("site_layers", "owner_user_id", window)),
        "made_site": len(users_with("custom_sites", "created_by", window)),
        "started_subscription": len(started),
    }
