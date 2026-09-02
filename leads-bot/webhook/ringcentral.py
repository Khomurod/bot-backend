"""
Inbound RingCentral SMS/MMS forwarded into the Telegram leads hub group.

DELIVERY IS BEST-EFFORT PER ATTACHMENT, NEVER ALL-OR-NOTHING. If some
attachments fail to download the rest are still forwarded; if ALL of them fail
the text still goes out with an explicit warning, so a recruiter sees the
message and knows media is missing rather than seeing nothing at all.

An album (sendMediaGroup) is used only for 2-10 photo-compatible files with
nothing else mixed in — Telegram's own limits — and a failed album falls back
to individual sends rather than dropping the media.

EVERY PATH REGISTERS AN SMS MIRROR, including the failure paths, because the
mirror is what lets a reply typed in the hub group find its way back to the
right phone number. Skipping it on a partial failure would leave a visible
message that cannot be answered.

Captions are HTML and every interpolated value is escaped: the phone number and
message body come from outside.

Split out of leads-bot/webhook_server.py.
"""
import html
import logging
import mimetypes

from sms import download_ringcentral_attachment

from .connect_command import _register_inbound_sms_mirror
from .telegram_client import (
    _send_telegram_html,
    _send_telegram_media_group_photos,
    _send_telegram_upload,
    _telegram_upload_method,
)

logger = logging.getLogger(__name__)

RC_INBOUND_TYPES = frozenset({"SMS", "MMS"})

def _format_ringcentral_forward_html(
    from_number: str,
    subject: str,
    created: str,
    *,
    warning_plain: str | None = None,
    max_body_len: int = 3500,
) -> str:
    """Build Telegram HTML: SMS body in <pre> (monospace), labels in bold/code."""
    body = subject if subject is not None else ""
    if len(body) > max_body_len:
        body = body[: max_body_len - 1] + "…"

    esc_from = html.escape(from_number)
    esc_body = html.escape(body)
    parts = [
        "\U0001f4e9 <b>SMS/MMS Reply Received!</b>",
        "",
        f"\U0001f4de From: <code>{esc_from}</code>",
        "\U0001f4ac Message:",
        f"<pre>{esc_body}</pre>",
    ]
    if created:
        parts.append(f"\U0001f550 Received: <code>{html.escape(created)}</code>")
    if warning_plain:
        parts.append("")
        parts.append(f"<i>{html.escape(warning_plain)}</i>")
    return "\n".join(parts)


def _fit_ringcentral_caption_html(
    from_number: str,
    subject: str,
    created: str,
    *,
    warning_plain: str | None = None,
) -> str:
    """Shrink SMS body in <pre> until full HTML fits Telegram's 1024-char caption limit."""
    limits = list(range(min(len(subject), 850), -1, -25))
    if not limits:
        limits = [0]
    for lim in limits:
        text = _format_ringcentral_forward_html(
            from_number,
            subject,
            created,
            warning_plain=warning_plain,
            max_body_len=max(lim, 0),
        )
        if len(text) <= 1024:
            return text
    return _format_ringcentral_forward_html(
        from_number,
        subject[:50],
        created,
        warning_plain=warning_plain,
        max_body_len=50,
    )


def _ringcentral_media_attachments(event_body: dict) -> list[dict]:
    """Attachment dicts that reference downloadable media (not plain Text duplicates)."""
    out: list[dict] = []
    for att in event_body.get("attachments") or []:
        if not isinstance(att, dict):
            continue
        uri = (att.get("uri") or att.get("contentUri") or "").strip()
        if not uri:
            continue
        atype = (att.get("type") or "").lower()
        ct = (att.get("contentType") or "").lower()
        if atype == "text" and ("text/plain" in ct or ct.startswith("text/")):
            continue
        if ct.startswith("image/") or ct.startswith("video/"):
            out.append(att)
            continue
        if atype in ("mmsattachment", "mms", "file", "attachment"):
            out.append(att)
    return out


def _attachment_download_filename(att: dict, content_type: str, index: int) -> str:
    raw = (att.get("fileName") or att.get("filename") or "").strip()
    if raw:
        return raw
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ".bin"
    return f"attachment_{index}{ext}"


async def _forward_ringcentral_inbound_to_telegram(event_body: dict) -> None:
    """Forward inbound SMS/MMS to Telegram: text via sendMessage; images/video via upload."""
    from_number = event_body.get("from", {}).get("phoneNumber", "Unknown")
    subject = event_body.get("subject", "(no text)")
    created = event_body.get("creationTime", "")

    media_atts = _ringcentral_media_attachments(event_body)
    if not media_atts:
        caption_html = _format_ringcentral_forward_html(from_number, subject, created)
        message_id = await _send_telegram_html(caption_html)
        await _register_inbound_sms_mirror(from_number, subject, message_id)
        logger.info("SMS reply from %s forwarded to Telegram (text only).", from_number)
        return

    caption_html = _fit_ringcentral_caption_html(from_number, subject, created)

    downloaded: list[tuple[bytes, str, str]] = []
    for i, att in enumerate(media_atts):
        uri = (att.get("uri") or att.get("contentUri") or "").strip()
        try:
            raw, ct = await download_ringcentral_attachment(uri)
            fn = _attachment_download_filename(att, ct, i)
            downloaded.append((raw, fn, ct))
            logger.info(
                "Downloaded RC attachment %d bytes, type %s",
                len(raw),
                ct,
            )
        except Exception as exc:
            logger.error("RingCentral attachment download failed (%s): %s", uri[:120], exc)

    if not downloaded:
        warn_html = _format_ringcentral_forward_html(
            from_number,
            subject,
            created,
            warning_plain="Could not download MMS attachments — check RingCentral credentials.",
        )
        message_id = await _send_telegram_html(warn_html)
        await _register_inbound_sms_mirror(from_number, subject, message_id)
        return

    photo_compatible: list[tuple[bytes, str, str]] = []
    other_items: list[tuple[bytes, str, str]] = []
    for item in downloaded:
        method, _ = _telegram_upload_method(item[2])
        if method == "sendPhoto":
            photo_compatible.append(item)
        else:
            other_items.append(item)

    if len(photo_compatible) >= 2 and len(photo_compatible) <= 10 and not other_items:
        album_message_id = await _send_telegram_media_group_photos(caption_html, photo_compatible)
        if album_message_id:
            await _register_inbound_sms_mirror(from_number, subject, album_message_id)
            logger.info("MMS from %s forwarded to Telegram as album (%d).", from_number, len(photo_compatible))
            return
        logger.warning("sendMediaGroup failed; falling back to individual sends.")

    first_message_id = None
    for idx, (b, fn, ct) in enumerate(downloaded):
        cap = caption_html if idx == 0 else ""
        method, field = _telegram_upload_method(ct)
        uploaded_id = await _send_telegram_upload(method, field, b, fn, ct, cap)
        if idx == 0 and uploaded_id:
            first_message_id = uploaded_id
    await _register_inbound_sms_mirror(from_number, subject, first_message_id)
    logger.info("MMS from %s forwarded to Telegram (%d file(s)).", from_number, len(downloaded))
