"""Sending logic for the portal's Email page.

Brought over on 30 Oct 2026 from the website repo
(`E:/code/visit-history-web/scripts/mailer_core.py`), where it served a
tkinter mailer and a command line. The portal is the email tool now; while
the website's copy still exists, a fix to one must be made to the other,
because the copy that drifted would be the one used at the moment it
mattered.

Standard library only. This is run a handful of times a year and an install
step is one more thing to go wrong then.
"""

from __future__ import annotations

import csv
import os
import re
import smtplib
import ssl
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

DEFAULT_HOST = "smtp.ionos.co.uk"
DEFAULT_PORT = 587

# IONOS throttles per hour and per day and the limit depends on the plan, so
# these defaults are deliberately timid. Raise them once the real number is
# known.
DEFAULT_DELAY = 8.0
DEFAULT_LIMIT = 40

# Some SMTP servers drop a connection that has sent many messages. Rather than
# find out which number that is, reconnect regularly.
DEFAULT_RECONNECT_EVERY = 20

# The suppression list. Separate from the sent log and never cleared, because
# the two answer different questions: the log says "already done with THIS
# campaign", the suppression list says "never, again, ever". Clearing the log
# to start a new campaign is normal and correct; doing the same to an
# unsubscribe would re-add somebody who has asked to be left alone, which is
# the failure that turns a polite request into a complaint.
DEFAULT_SUPPRESSION_NAME = "unsubscribed.txt"

# Permissive on purpose. This catches a missing @ and a stray space, which is
# what a hand-edited list actually suffers from; it is not trying to decide
# whether a mailbox exists, which only the server can answer.
ADDRESS_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")


@dataclass
class SmtpConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    user: str = ""
    password: str = ""


@dataclass
class Message:
    subject: str = ""
    sender: str = ""
    reply_to: str = ""
    unsubscribe: str = ""
    text_body: str = ""
    html_body: str = ""


@dataclass
class BatchResult:
    sent: int = 0
    refused: int = 0
    stopped: bool = False
    stopped_on: str = ""
    reason: str = ""
    refusals: list[tuple[str, str]] = field(default_factory=list)


# --------------------------------------------------------------------------
# Recipients
# --------------------------------------------------------------------------

def read_recipients_csv(path: str) -> list[str]:
    """Addresses from a CSV, in file order.

    Accepts what Supabase's SQL editor downloads, which is a file with an
    `email` column among others. A single-column file with no header works too,
    because that is what a list pasted out of a spreadsheet looks like.
    """
    out: list[str] = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        first_line = fh.readline()
        fh.seek(0)
        if "email" in first_line.lower():
            reader = csv.DictReader(fh)
            field_name = next(
                (f for f in (reader.fieldnames or []) if f.strip().lower() == "email"),
                None,
            )
            if not field_name:
                raise ValueError(f"{path}: has a header row but no 'email' column")
            for row in reader:
                out.append((row.get(field_name) or "").strip())
        else:
            for row in csv.reader(fh):
                out.append((row[0] if row else "").strip())
    return [a for a in out if a]


def clean_list(raw_lines) -> tuple[list[str], list[str], int]:
    """Split a hand-editable list into (valid, invalid, duplicates_removed).

    Lowercased and deduplicated, keeping first appearance, because a person who
    signed up twice has one inbox. Invalid lines are handed back rather than
    dropped silently: a typo in a list you are about to email is worth seeing.
    """
    seen: set[str] = set()
    valid: list[str] = []
    invalid: list[str] = []
    duplicates = 0

    for raw in raw_lines:
        # Tolerate a pasted CSV row or a "Name <addr>" line.
        line = (raw or "").strip().strip(",;")
        if not line:
            continue
        if "," in line:
            line = line.split(",", 1)[0].strip()
        if "<" in line and ">" in line:
            line = parseaddr(line)[1]

        address = line.lower()
        if not ADDRESS_RE.match(address):
            invalid.append(raw.strip())
            continue
        if address in seen:
            duplicates += 1
            continue
        seen.add(address)
        valid.append(address)

    return valid, invalid, duplicates


# --------------------------------------------------------------------------
# The sent log: what makes a resumed run safe
# --------------------------------------------------------------------------

def read_log(path: str) -> set[str]:
    """Addresses from a log or suppression file, lowercased.

    Reads the address off each line and ignores the rest, so the same parser
    serves the sent log (`address,status,timestamp`) and a suppression list,
    which may be bare addresses, the same three fields, or a mixture with
    `#` comments. Anything hand-edited stays readable.
    """
    if not path or not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        return {
            line.split(",", 1)[0].strip().lower()
            for line in fh
            if line.strip() and not line.startswith("#")
        }


def append_suppression(path: str, address: str, note: str = "unsubscribed") -> bool:
    """Add an address to the suppression list. Returns False if already there.

    Creates the file with a header the first time, because somebody opening it
    in a year should not have to guess what it is or whether deleting a line
    is safe.
    """
    address = address.strip().lower()
    if not address:
        return False
    if address in read_log(path):
        return False

    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    new_file = not os.path.exists(path) or os.path.getsize(path) == 0
    with open(path, "a", encoding="utf-8") as fh:
        if new_file:
            fh.write(
                "# Addresses that have asked never to be emailed again.\n"
                "# Subtracted from every send, in addition to the sent log.\n"
                "# Never clear this file. Clearing the sent log between\n"
                "# campaigns is normal; clearing this would re-add people who\n"
                "# have opted out. One address per line; text after the first\n"
                "# comma is a note and is ignored.\n"
            )
        fh.write(f"{address},{note},{datetime.now(timezone.utc).isoformat()}\n")
    return True


def append_log(path: str, address: str, status: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"{address},{status},{datetime.now(timezone.utc).isoformat()}\n")


# --------------------------------------------------------------------------
# Sending
# --------------------------------------------------------------------------

def build_message(msg: Message, recipient: str) -> EmailMessage:
    sender = msg.sender or msg.unsubscribe or "unset@example.invalid"
    domain = parseaddr(sender)[1].rsplit("@", 1)[-1] or "localhost"

    out = EmailMessage()
    out["From"] = sender
    out["To"] = recipient
    out["Subject"] = msg.subject
    out["Date"] = formatdate(localtime=True)
    out["Message-ID"] = make_msgid(domain=domain)
    if msg.reply_to:
        out["Reply-To"] = msg.reply_to

    # The email itself asks people to reply with "unsubscribe". This header
    # gives Gmail and friends a native button that does the same, which keeps
    # a complaint out of the spam report, where it would cost deliverability.
    # mailto only, and no List-Unsubscribe-Post: one-click needs an endpoint
    # that honours a POST and there isn't one.
    if msg.unsubscribe:
        out["List-Unsubscribe"] = f"<mailto:{msg.unsubscribe}?subject=unsubscribe>"

    out.set_content(msg.text_body, subtype="plain", charset="utf-8")
    if msg.html_body.strip():
        out.add_alternative(msg.html_body, subtype="html", charset="utf-8")
    return out


def connect(cfg: SmtpConfig, timeout: float = 45.0) -> smtplib.SMTP:
    context = ssl.create_default_context()
    if cfg.port == 465:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            cfg.host, cfg.port, timeout=timeout, context=context
        )
    else:
        server = smtplib.SMTP(cfg.host, cfg.port, timeout=timeout)
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
    server.login(cfg.user, cfg.password)
    return server


def check_connection(cfg: SmtpConfig) -> str:
    """Log in and hang up, sending nothing. Returns the server's greeting."""
    server = connect(cfg)
    try:
        code, text = server.noop()
        greeting = getattr(server, "_host", cfg.host)
        detail = text.decode("utf-8", "replace") if isinstance(text, bytes) else str(text)
        return f"{greeting}: signed in, NOOP {code} {detail}".strip()
    finally:
        try:
            server.quit()
        except smtplib.SMTPException:
            pass


def send_batch(
    cfg: SmtpConfig,
    msg: Message,
    recipients: list[str],
    *,
    delay: float = DEFAULT_DELAY,
    reconnect_every: int = DEFAULT_RECONNECT_EVERY,
    log_path: str | None = None,
    on_event=None,
    should_stop=None,
) -> BatchResult:
    """Send one message per recipient, pacing between them.

    `on_event(kind, address, detail, index, total)` is called as things happen,
    with kind one of sent / refused / stopped / info. `should_stop()` is polled
    between messages so a caller with a Stop button can interrupt cleanly,
    after a send rather than during one.

    A refused recipient is recorded and the run continues, because one bad
    address is not a reason to abandon the rest. A connection-level failure
    stops the run, because a server that has begun throttling should not be
    hammered, and the address it failed on is deliberately left out of the log
    so the next run retries it.
    """
    result = BatchResult()
    total = len(recipients)

    def emit(kind, address="", detail="", index=0):
        if on_event:
            on_event(kind, address, detail, index, total)

    if not recipients:
        emit("info", detail="nothing to send")
        return result

    emit("info", detail=f"connecting to {cfg.host}:{cfg.port}")
    server = connect(cfg)
    emit("info", detail="signed in")

    try:
        for i, address in enumerate(recipients, start=1):
            if should_stop and should_stop():
                result.stopped = True
                result.reason = "stopped by request"
                emit("stopped", address, "stopped by request", i)
                break

            if i > 1 and (i - 1) % max(1, reconnect_every) == 0:
                try:
                    server.quit()
                except smtplib.SMTPException:
                    pass
                emit("info", detail="reconnecting")
                server = connect(cfg)

            try:
                server.send_message(build_message(msg, address))
            except (smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError) as exc:
                result.refused += 1
                result.refusals.append((address, str(exc)))
                if log_path:
                    append_log(log_path, address, "refused")
                emit("refused", address, str(exc), i)
            except (smtplib.SMTPException, OSError) as exc:
                result.stopped = True
                result.stopped_on = address
                result.reason = str(exc)
                emit("stopped", address, str(exc), i)
                break
            else:
                result.sent += 1
                if log_path:
                    append_log(log_path, address, "sent")
                emit("sent", address, "", i)

            if i < total:
                # Sleep in slices so Stop feels immediate rather than taking a
                # whole delay to notice.
                waited = 0.0
                while waited < delay:
                    if should_stop and should_stop():
                        break
                    step = min(0.25, delay - waited)
                    time.sleep(step)
                    waited += step
    finally:
        try:
            server.quit()
        except smtplib.SMTPException:
            pass

    return result
