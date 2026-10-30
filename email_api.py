"""The Email page's half of the Python API, mixed into `backend.Api`.

Sending is `mailer_core`, choosing who to send to is `audience`; this is the
glue the page calls, and the state that has to outlive one call: the running
send and its events.

Settings, the sent log and the opt-out list live where the old tkinter mailer
kept them, in %LOCALAPPDATA%/VisitHistory/bulk-mailer/, so the two read the
same state and nothing has to be moved. None of it goes in a repo: it holds
addresses, and the website repo is pushed to GitHub.

The SMTP password is never written anywhere. It comes from the page each
session, or from IONOS_SMTP_PASSWORD if the page leaves it blank.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone

import webview

import audience
import mailer_core as core

MAILER_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "VisitHistory",
    "bulk-mailer",
)
MAILER_CONFIG = os.path.join(MAILER_DIR, "config.json")

# The second copy of the opt-out list, on another drive (VIS-75). The page
# warns when the live list is missing or has fewer addresses than this.
OPTOUT_BACKUP = r"E:\backups\visit-history-mailer\unsubscribed.txt"

# Everything the page may save. The password is deliberately not here.
SAVED_KEYS = (
    "host", "port", "user", "subject", "sender", "reply_to", "unsubscribe",
    "delay", "limit", "reconnect_every", "log_path", "suppress_path",
    "test_address", "recipients", "text_body", "html_body", "campaign",
)


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:60]


def _load():
    try:
        with open(MAILER_CONFIG, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = {}
    cfg.setdefault("host", core.DEFAULT_HOST)
    cfg.setdefault("port", core.DEFAULT_PORT)
    cfg.setdefault("delay", core.DEFAULT_DELAY)
    cfg.setdefault("limit", core.DEFAULT_LIMIT)
    cfg.setdefault("reconnect_every", core.DEFAULT_RECONNECT_EVERY)
    cfg.setdefault("log_path", os.path.join(MAILER_DIR, "sent.log"))
    cfg.setdefault("suppress_path", os.path.join(MAILER_DIR, core.DEFAULT_SUPPRESSION_NAME))
    return cfg


def _number(value, fallback, kind=float):
    try:
        return kind(float(value))
    except (TypeError, ValueError):
        return fallback


class EmailApi:
    _email_lock = threading.Lock()
    _email_job = None

    # -- settings -------------------------------------------------------

    def email_settings(self):
        cfg = _load()
        live = core.read_log(cfg["suppress_path"])
        backup = core.read_log(OPTOUT_BACKUP)
        cfg.update({
            "campaign": cfg.get("campaign") or "",
            "log_count": len(core.read_log(cfg["log_path"])),
            "password_from_env": bool(os.environ.get("IONOS_SMTP_PASSWORD")),
            "optouts": len(live),
            "optout_list_exists": os.path.exists(cfg["suppress_path"]),
            "optouts_missing_from_live": len(backup - live),
            "optouts_missing_from_backup": len(live - backup),
            "optout_backup": OPTOUT_BACKUP,
        })
        return cfg

    def email_save_settings(self, data):
        cfg = _load()
        cfg.update({k: v for k, v in (data or {}).items() if k in SAVED_KEYS})
        try:
            os.makedirs(MAILER_DIR, exist_ok=True)
            with open(MAILER_CONFIG, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, indent=2)
        except OSError as exc:
            return {"error": str(exc)}
        return {"ok": True}

    def email_new_campaign(self, name):
        """Point the sent log at a fresh file for a new campaign.

        The sent log is what stops a resumed run sending anyone twice, so it
        has to be per campaign: left on the last one, every address that one
        reached reads as "already sent" and is silently skipped. Old logs are
        kept rather than cleared, because they are what a campaign's results
        are read from.
        """
        if self._email_job and self._email_job["running"]:
            return {"error": "Wait for the current send to finish."}
        slug = _slug(name)
        if not slug:
            return {"error": "Give the campaign a name, such as whats-new-nov26."}
        cfg = _load()
        cfg["campaign"] = name.strip()
        cfg["log_path"] = os.path.join(MAILER_DIR, f"sent-{slug}.log")
        saved = self.email_save_settings(cfg)
        if saved.get("error"):
            return saved
        return self.email_settings()

    def email_open_body(self):
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("Text or HTML (*.txt;*.html;*.htm)", "All files (*.*)"),
        )
        if not result:
            return None
        path = result[0]
        with open(path, encoding="utf-8") as fh:
            return {"name": os.path.basename(path), "text": fh.read()}

    # -- recipients -----------------------------------------------------

    def email_audience(self, include_admins=False):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            return audience.audience(client, include_admins=bool(include_admins))
        except Exception as exc:  # noqa: BLE001 - shown on the page
            return {"error": str(exc)}

    def _remaining(self, text):
        cfg = _load()
        valid, invalid, dupes = core.clean_list((text or "").splitlines())
        sent = core.read_log(cfg["log_path"])
        opted_out = core.read_log(cfg["suppress_path"])
        remaining = [a for a in valid if a not in sent and a not in opted_out]
        return cfg, valid, invalid, dupes, remaining, {
            "valid": len(valid),
            "duplicates": dupes,
            "unusable": invalid[:20],
            "unusable_count": len(invalid),
            "opted_out": sum(1 for a in valid if a in opted_out),
            "already_sent": sum(1 for a in valid if a in sent and a not in opted_out),
            "to_go": len(remaining),
        }

    def email_recount(self, text):
        return self._remaining(text)[-1]

    def email_clean(self, text):
        valid, invalid, _ = core.clean_list((text or "").splitlines())
        return {"valid": valid, "invalid": invalid}

    def email_remaining_list(self, text):
        return self._remaining(text)[4]

    def email_add_optout(self, address):
        address = (address or "").strip().lower()
        if not core.ADDRESS_RE.match(address):
            return {"error": "That does not look like an address."}
        added = core.append_suppression(_load()["suppress_path"], address)
        return {"added": added}

    # -- sending --------------------------------------------------------

    def _smtp(self, smtp):
        smtp = smtp or {}
        return core.SmtpConfig(
            host=(smtp.get("host") or core.DEFAULT_HOST).strip(),
            port=_number(smtp.get("port"), core.DEFAULT_PORT, int),
            user=(smtp.get("user") or "").strip(),
            password=smtp.get("password") or os.environ.get("IONOS_SMTP_PASSWORD", ""),
        )

    @staticmethod
    def _message(m):
        m = m or {}
        return core.Message(
            subject=m.get("subject") or "",
            sender=(m.get("sender") or m.get("user") or "").strip(),
            reply_to=(m.get("reply_to") or "").strip(),
            unsubscribe=(m.get("unsubscribe") or "").strip(),
            text_body=m.get("text_body") or "",
            html_body=m.get("html_body") or "",
        )

    def email_test_connection(self, smtp):
        cfg = self._smtp(smtp)
        if not (cfg.user and cfg.password):
            return {"error": "Fill in the mailbox and password first."}
        try:
            return {"ok": core.check_connection(cfg)}
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}

    def email_plan(self, text, limit):
        """What a batch send would do, for the confirmation before it."""
        cfg, _, _, _, remaining, counts = self._remaining(text)
        batch = remaining[:max(1, _number(limit, core.DEFAULT_LIMIT, int))]
        return dict(counts, batch=len(batch), first=batch[:5],
                    left_after=len(remaining) - len(batch),
                    campaign=cfg.get("campaign") or "", log_path=cfg["log_path"])

    def email_send(self, kind, smtp, message, text="", test_address="", pacing=None, confirmed=None):
        """Start a send on a thread. The page polls email_status().

        A batch goes only when `confirmed` is the number of people it would
        reach right now, which the page asks to be typed. The check is here as
        well as on the page so that nothing can send a batch without it: if
        the list, the log or the opt-outs changed after the dialog opened, the
        number no longer matches and nothing is sent.
        """
        with self._email_lock:
            if self._email_job and self._email_job["running"]:
                return {"error": "A send is already going."}
            cfg_smtp, msg = self._smtp(smtp), self._message(message)
            missing = [name for name, ok in (
                ("the mailbox username", cfg_smtp.user), ("the password", cfg_smtp.password),
                ("a subject", msg.subject.strip()), ("a plain-text body", msg.text_body.strip()),
            ) if not ok]
            if missing:
                return {"error": "Still missing: " + ", ".join(missing) + "."}

            pacing = pacing or {}
            if kind == "test":
                address = (test_address or "").strip().lower()
                if not core.ADDRESS_RE.match(address):
                    return {"error": "Put a test address in first."}
                recipients, log_path = [address], None  # a test is never logged
            else:
                cfg, _, _, _, remaining, _ = self._remaining(text)
                recipients = remaining[:max(1, _number(pacing.get("limit"), core.DEFAULT_LIMIT, int))]
                log_path = cfg["log_path"]
                if not recipients:
                    return {"error": "Nothing left to send. The list is all in the log or opted out."}
                if _number(confirmed, -1, int) != len(recipients):
                    return {"error": f"Not sent. This batch is {len(recipients)} people and the "
                                     f"confirmation said {confirmed}. Check the list and confirm again."}

            job = {"running": True, "events": [], "stop": threading.Event(),
                   "kind": kind, "total": len(recipients), "summary": "", "error": ""}
            self._email_job = job

        def on_event(kind_, address, detail, index, total):
            job["events"].append({"kind": kind_, "address": address, "detail": detail,
                                  "index": index, "total": total,
                                  "at": datetime.now(timezone.utc).isoformat()})

        def work():
            try:
                result = core.send_batch(
                    cfg_smtp, msg, recipients,
                    delay=_number(pacing.get("delay"), core.DEFAULT_DELAY),
                    reconnect_every=_number(pacing.get("reconnect_every"),
                                            core.DEFAULT_RECONNECT_EVERY, int),
                    log_path=log_path, on_event=on_event, should_stop=job["stop"].is_set,
                )
                job["summary"] = f"{result.sent} sent, {result.refused} refused"
                if result.stopped:
                    job["summary"] += f", stopped on {result.stopped_on or 'request'}: {result.reason}"
            except Exception as exc:  # noqa: BLE001
                job["error"] = str(exc)
            finally:
                job["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return {"started": len(recipients)}

    def email_status(self, since=0):
        job = self._email_job
        if not job:
            return {"running": False, "events": [], "next": 0}
        events = job["events"][since:]
        return {"running": job["running"], "events": events, "next": since + len(events),
                "total": job["total"], "kind": job["kind"],
                "summary": job["summary"], "error": job["error"]}

    def email_stop(self):
        if self._email_job:
            self._email_job["stop"].set()
        return {"ok": True}

    # -- results --------------------------------------------------------

    def email_read(self, source, text, since, until=None):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            if source == "log":
                addresses = core.read_log(_load()["log_path"])
            else:
                addresses = core.clean_list((text or "").splitlines())[0]
            if not addresses:
                return {"error": "No addresses to read: the " +
                        ("sent log is empty." if source == "log" else "list is empty.")}
            return audience.campaign_read(client, addresses, since, until or None)
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}
