"""Read visible text bubbles from the dedicated WeChat Linux test desktop."""

from dataclasses import dataclass
import re
import unicodedata
from difflib import SequenceMatcher

from PIL import Image


Box = tuple[int, int, int, int]
COLORS = {
    (238, 238, 240): "incoming",
    (157, 242, 159): "outgoing",
}
QUOTE_BAR = (224, 224, 224)
MENTION_BANNERS = {
    "[youwerementioned]": 64,
    "[有人@我]": 24,
    "[有人艾特我]": 24,
}


@dataclass(frozen=True)
class VisibleMessage:
    direction: str
    sender: str | None
    text: str
    mentions_account: bool
    quotes_account: bool
    box: Box
    quoted_sender: str | None = None
    quoted_text: str | None = None

    @property
    def center(self) -> tuple[int, int]:
        x, y, width, height = self.box
        return x + width // 2, y + height // 2

    @property
    def identity(self) -> tuple:
        return (self.direction, key(self.sender), key(self.text), key(self.quoted_sender), key(self.quoted_text))


@dataclass(frozen=True)
class MessageSnapshot:
    context: str
    messages: tuple[VisibleMessage, ...]


def key(value: str | None) -> str:
    return " ".join(unicodedata.normalize("NFKC", value or "").split())


def contains_mention(text: str, name: str) -> bool:
    normalized_name = key(name)
    if not normalized_name:
        return False
    pattern = rf"@\s*{re.escape(normalized_name)}(?=$|\s|[，。！？：、；,.!?:;])"
    return re.search(pattern, key(text)) is not None


def native_group_mention(image_path, ocr_lines, sidebar_rect: Box, group_title: str, *, group_row=None) -> bool:
    """Confirm WeChat's red sidebar indicator for one enrolled group row."""
    expected_title = unicodedata.normalize("NFC", group_title)
    if not expected_title.strip():
        return False
    lines = [line for line in ocr_lines if center_inside(line, sidebar_rect)]
    titles = ([group_row] if group_row in lines else []) if group_row is not None else [
        line for line in lines if unicodedata.normalize("NFC", line["text"]) == expected_title
    ]
    if len(titles) != 1:
        return False
    title = titles[0]
    candidates = []
    for line in lines:
        if abs(line["x"] - title["x"]) > 8 or not 11 <= line["y"] - title["y"] <= 34:
            continue
        if line["y"] < title["y"] + title["height"] - 4:
            continue
        text = "".join(key(line["text"]).split()).casefold()
        prefix = next((prefix for prefix in MENTION_BANNERS if text.startswith(prefix)), None)
        if prefix:
            candidates.append((line, MENTION_BANNERS[prefix]))
    if len(candidates) != 1:
        return False
    line, minimum_span = candidates[0]
    left, top, width, height = sidebar_rect
    x, y, line_width, line_height = (line[field] for field in ("x", "y", "width", "height"))
    if not (left <= x < x + line_width <= left + width and top <= y < y + line_height <= top + height):
        return False
    with Image.open(image_path) as image:
        if not (0 <= x < x + line_width <= image.width and 0 <= y < y + line_height <= image.height):
            return False
        banner = image.crop((x, y, x + line_width, y + line_height)).convert("RGB")
    return has_red_banner_glyphs(banner, minimum_span)


def has_red_banner_glyphs(image: Image.Image, minimum_span: int) -> bool:
    # The first glyph is a red opening bracket. Requiring its position and a
    # broad run of red glyphs rejects normal gray text and nearby unread dots.
    pixels = image.load()
    columns = set()
    rows = set()
    core = 0
    for y in range(image.height):
        for x in range(min(image.width, minimum_span * 3)):
            red, green, blue = pixels[x, y]
            if red >= 200 and red - max(green, blue) >= 55 and abs(green - blue) <= 12:
                columns.add(x)
                rows.add(y)
                if 245 <= red <= 255 and 70 <= green <= 100 and 70 <= blue <= 100:
                    core += 1
    return bool(columns) and min(columns) <= 8 and max(columns) - min(columns) >= minimum_span and (
        len(columns) >= minimum_span // 2 and len(rows) >= 6 and core >= 8
    )


def bubble_boxes(image: Image.Image, chat_rect: Box) -> list[tuple[str, Box]]:
    left, top, width, height = chat_rect
    if width < 96 or height <= 0 or left < 0 or top < 0 or left + width > image.width or top + height > image.height:
        raise ValueError("Chat rectangle is outside the captured desktop.")
    chat = image.crop((left, top, left + width, top + height)).convert("RGB")
    pixels = chat.load()
    # Follow the continuous margin beside the text rather than mistaking centered
    # system notices, sender labels or avatars for message bubbles.
    sample_columns = {
        "incoming": range(round(width * 0.11) + 5, round(width * 0.11) + 13),
        "outgoing": range(round(width * 0.89) - 13, round(width * 0.89) - 5),
    }
    boxes = []
    for color, direction in COLORS.items():
        rows = [y for y in range(height) if sum(pixels[x, y] == color for x in sample_columns[direction]) >= 4]
        for start, end in continuous_ranges(rows):
            if start == 0 or end == height or end - start < 22:
                continue
            # Include all continuous background next to the fixed-side padding.
            # Interior text pixels can interrupt a row, so combine the extent of
            # several rows, including the blank padding above and below text.
            positions = [
                x for x in range(width)
                if sum(pixels[x, y] == color for y in range(start, end)) >= 6
            ]
            spans = continuous_ranges(positions)
            anchor = sample_columns[direction][len(sample_columns[direction]) // 2]
            span = next(((first, last) for first, last in spans if first <= anchor < last), None)
            if span is None or span[1] - span[0] < 24:
                continue
            first, last = span
            box = left + first, top + start, last - first, end - start
            boxes.append((direction, box))
    return sorted(boxes, key=lambda item: item[1][1])


def continuous_ranges(rows: list[int]) -> list[tuple[int, int]]:
    if not rows:
        return []
    ranges = []
    first = previous = rows[0]
    for row in rows[1:]:
        if row - previous > 1:
            ranges.append((first, previous + 1))
            first = row
        previous = row
    ranges.append((first, previous + 1))
    return ranges


def center_inside(line: dict, box: Box) -> bool:
    x, y, width, height = box
    return (
        x <= line["x"] + line["width"] / 2 < x + width
        and y <= line["y"] + line["height"] / 2 < y + height
    )


def extract_messages(image_path, ocr_lines, chat_rect: Box, *, target: str, account_name: str,
                     peer_name: str | None = None) -> tuple[VisibleMessage, ...]:
    if target not in ("private", "group"):
        raise ValueError("Expected a private or group test conversation.")
    with Image.open(image_path) as source:
        image = source.convert("RGB")
    boxes = bubble_boxes(image, chat_rect)
    lines = sorted(
        (line for line in ocr_lines if center_inside(line, chat_rect) and key(line["text"])),
        key=lambda line: (line["y"], line["x"]),
    )
    messages = []
    for index, (direction, box) in enumerate(boxes):
        body = [line["text"].strip() for line in lines if center_inside(line, box)]
        if not body:
            continue
        text = "\n".join(body)
        if direction == "outgoing":
            sender = account_name
        elif target == "private":
            sender = peer_name
        else:
            sender = group_sender(lines, box)
        next_row = boxes[index + 1][1][1] if index + 1 < len(boxes) else chat_rect[1] + chat_rect[3]
        quoted_sender, quoted_text = native_quote(image, lines, direction, box, next_row)
        messages.append(VisibleMessage(
            direction=direction,
            sender=sender,
            text=text,
            mentions_account=direction == "incoming" and contains_mention(text, account_name),
            quotes_account=direction == "incoming" and quoted_sender is not None and key(quoted_sender) == key(account_name),
            box=box,
            quoted_sender=quoted_sender,
            quoted_text=quoted_text,
        ))
    return tuple(messages)


def group_sender(lines: list[dict], box: Box) -> str | None:
    x, y, _, _ = box
    labels = [
        line["text"].strip() for line in lines
        if x - 7 <= line["x"] <= x + 7 and 0 <= y - (line["y"] + line["height"]) <= 12
    ]
    return labels[0] if len(labels) == 1 else None


def native_quote(image: Image.Image, lines: list[dict], direction: str, box: Box,
                 next_row: int) -> tuple[str | None, str | None]:
    x, y, width, height = box
    end = y + height
    # The client renders a gray vertical bar at the avatar side of the quote.
    # The text lies under the bubble, on the opposite side of that bar.
    anchor = x if direction == "incoming" else x + width - 3
    start = end + 6
    stop = min(end + 28, next_row)
    if stop - start < 13:
        return None, None
    pixels = image.load()
    for bar_x in range(anchor - 3, anchor + 4):
        if bar_x < 0 or bar_x + 1 >= image.width:
            continue
        bar_rows = [row for row in range(start, stop) if pixels[bar_x, row] == pixels[bar_x + 1, row] == QUOTE_BAR]
        for top, bottom in continuous_ranges(bar_rows):
            if bottom - top < 10:
                continue
            return quote_label(lines, direction, bar_x, top, bottom)
    return None, None


def quote_label(lines: list[dict], direction: str, bar_x: int, top: int,
                bottom: int) -> tuple[str | None, str | None]:
    candidates = []
    for line in lines:
        center_y = line["y"] + line["height"] / 2
        edge = line["x"] if direction == "incoming" else line["x"] + line["width"]
        gap = edge - bar_x if direction == "incoming" else bar_x - edge
        # OCR can include the narrow quote bar as a leading or trailing pipe.
        if not top <= center_y <= bottom or not -8 <= gap <= 18:
            continue
        pieces = re.split("[:：]", line["text"].strip("|丨 "), maxsplit=1)
        if len(pieces) == 2 and all(piece.strip() for piece in pieces):
            sender, original = pieces
            candidates.append((sender.strip(), original.strip()))
    return candidates[0] if len(candidates) == 1 else (None, None)


def new_messages(previous: MessageSnapshot, current: MessageSnapshot) -> tuple[VisibleMessage, ...] | None:
    """Return new incoming messages, or None when the screen cannot prove continuity."""
    if previous.context != current.context:
        return None
    old = tuple(message.identity for message in previous.messages)
    new = tuple(message.identity for message in current.messages)
    if old == new:
        return ()
    overlaps = [count for count in range(1, min(len(old), len(new)) + 1) if old[-count:] == new[:count]]
    if not overlaps:
        # An OCR pass can recover an older bubble at the top as the pane moves.
        # Require two exact consecutive anchors before accepting anything below
        # them, and require every admissible alignment to agree on new arrivals.
        for start in range(1, min(3, len(new) - 1)):
            overlaps.extend(start + count for count in range(2, min(len(old), len(new) - start) + 1)
                            if old[-count:] == new[start:start + count])
    if not overlaps and previous.context == "private":
        # The verified owner's recent text can be preceded by a multiline
        # card whose OCR differs as the conversation scrolls. The exact last
        # incoming bubble anchors one shared vertical shift across the match.
        if old and old[-1][0] == "incoming" and old.count(old[-1]) == new.count(old[-1]) == 1:
            count = new.index(old[-1]) + 1
            if 2 <= count <= len(old):
                aligned = tuple(zip(previous.messages[-count:], current.messages[:count]))
                changed = [(before, after) for before, after in aligned[:-1] if before.identity != after.identity]
                if len(changed) == 1 and share_vertical_shift(aligned):
                    exact = {before.identity for before, after in aligned if before.identity == after.identity
                             and old.count(before.identity) == new.count(before.identity) == 1}
                    if older_private_ocr_drift(*changed[0]) or (
                        len(exact) >= 2 and short_private_outgoing_ocr_drift(*changed[0])
                    ):
                        overlaps.append(count)
    if not overlaps:
        # OCR can misread an emoji anywhere in an already-sent bubble or
        # omit its quote card. Keep a substantial exact prefix of the
        # overlapping history and allow small drift only in the last,
        # outgoing bubble. Incoming identities always compare exactly.
        for count in range(2, min(len(old), len(new)) + 1):
            if old[-count:-1] != new[:count - 1]:
                continue
            before, after = previous.messages[-1], current.messages[count - 1]
            if before.direction != "outgoing" or after.direction != "outgoing" or before.sender != after.sender:
                continue
            before_text = "".join(key(before.text).split())
            after_text = "".join(key(after.text).split())
            if min(len(before_text), len(after_text)) >= 20 and (
                SequenceMatcher(None, before_text, after_text, autojunk=False).ratio() >= 0.90
            ):
                overlaps.append(count)
    if not overlaps and previous.context == "private":
        # One own bubble can change OCR as a new reply or reminder scrolls
        # the frame. Two unique exact anchors must bracket that changed row.
        for count in range(3, min(len(old), len(new)) + 1):
            aligned = tuple(zip(previous.messages[-count:], current.messages[:count]))
            changed = [index for index, (before, after) in enumerate(aligned) if before.identity != after.identity]
            if len(changed) != 1 or not 0 < changed[0] < count - 1 or not share_vertical_shift(aligned):
                continue
            index = changed[0]
            before, after = aligned[index]
            neighbors = (aligned[index - 1][0].identity, aligned[index + 1][0].identity)
            if before.direction == after.direction == "outgoing" and all(old.count(anchor) == new.count(anchor) == 1 for anchor in neighbors) and (
                older_private_ocr_drift(before, after) or short_private_outgoing_ocr_drift(before, after)
            ):
                overlaps.append(count)
    if not overlaps and previous.context == "private":
        overlaps.extend(private_outgoing_ocr_overlaps(previous.messages, current.messages, old, new))
    if not overlaps and previous.context == "private":
        overlaps.extend(private_bracketed_outgoing_overlaps(previous.messages, current.messages, old, new))
    if not overlaps and previous.context == "private":
        overlaps.extend(private_cron_history_overlaps(previous.messages, current.messages))
    if not overlaps:
        return None
    candidates = [tuple(message for message in current.messages[count:] if message.direction == "incoming")
                  for count in overlaps]
    if any(candidate != candidates[-1] for candidate in candidates):
        return None
    return candidates[-1]


def share_vertical_shift(aligned) -> bool:
    before_anchor, after_anchor = aligned[-1]
    shift = after_anchor.box[1] - before_anchor.box[1]
    return all((before.box[0], before.box[1] + shift, *before.box[2:]) == tuple(after.box)
               for before, after in aligned)


def private_bracketed_outgoing_overlaps(before, after, old, new):
    # When a notification scrolls the pane, two own text bubbles can repaint
    # on either side of one unchanged owner message. Never fuzz an incoming
    # bubble or an outgoing bubble with a native quote.
    overlaps = []
    for count in range(3, min(len(old), len(new)) + 1):
        aligned = tuple(zip(before[-count:], after[:count]))
        changed = [index for index, (left, right) in enumerate(aligned) if left.identity != right.identity]
        if len(changed) != 2 or not share_vertical_shift(aligned):
            continue
        first, last = changed
        if not any(left.direction == "incoming" and left.sender and old.count(left.identity) == new.count(left.identity) == 1
                   for left, _ in aligned[first + 1:last]):
            continue
        if all(strong_private_outgoing_ocr_drift(*aligned[index]) for index in changed):
            overlaps.append(count)
    return overlaps


def strong_private_outgoing_ocr_drift(before, after):
    if (before.direction != "outgoing" or after.direction != "outgoing" or not before.sender
            or before.sender != after.sender or before.quoted_sender or before.quoted_text
            or after.quoted_sender or after.quoted_text):
        return False
    left = "".join(key(before.text).split())
    right = "".join(key(after.text).split())
    return min(len(left), len(right)) >= 25 and SequenceMatcher(None, left, right, autojunk=False).ratio() >= .96


def private_cron_history_overlaps(before, after):
    """Allow one missing hyphen in an old cron command followed by its exact own reply."""
    if len(before) < 2 or len(after) < 2:
        return []
    command, reply = before[-2:]
    seen_command, seen_reply = after[:2]
    if (command.direction != "incoming" or seen_command.direction != "incoming"
            or not command.sender or command.sender != seen_command.sender
            or reply.direction != "outgoing" or seen_reply.direction != "outgoing"
            or not reply.sender or reply.sender != seen_reply.sender
            or any(row.quoted_sender or row.quoted_text for row in (command, reply, seen_command, seen_reply))
            or not share_vertical_shift(((command, seen_command), (reply, seen_reply)))):
        return []
    previous_command, current_command = key(command.text), key(seen_command.text)
    if not re.match(r"^/cron\s+(?:once|task|add)\s", previous_command, re.IGNORECASE):
        return []
    compact_command = "".join(previous_command.split())
    compact_seen = "".join(current_command.split())
    delimiters = re.findall(r"(?<!-)--(?!-)", compact_command)
    if len(delimiters) != 1 or re.sub(r"(?<!-)--(?!-)", "-", compact_command) != compact_seen:
        return []
    reply_text = "".join(key(reply.text).split())
    def same_own_reply(row):
        return row.direction == "outgoing" and row.sender == reply.sender and "".join(key(row.text).split()) == reply_text

    if (len(reply_text) < 25 or not same_own_reply(seen_reply)
            or any(sum(same_own_reply(row) for row in frame) != 1 for frame in (before, after))
            or sum(row.identity == command.identity for row in before) != 1
            or sum(row.identity == seen_command.identity for row in after) != 1):
        return []
    return [2]


def private_outgoing_ocr_overlaps(before, after, old, new):
    # An old outgoing bubble may go unread between two exact bubbles, and
    # the last short outgoing bubble may have one OCR substitution.
    if not before or before[-1].direction != "outgoing":
        return []
    unique = {identity for identity in old if old.count(identity) == new.count(identity) == 1}
    overlaps = []
    for start in range(len(old) - 2):
        for gap in (None, *range(start + 1, len(old) - 2)):
            if gap is not None and (old[gap][0] != "outgoing" or old[gap] in new
                                    or old[gap - 1] not in unique or old[gap + 1] not in unique):
                continue
            retained = tuple(index for index in range(start, len(old)) if index != gap)
            count = len(retained)
            if count > len(new):
                continue
            anchors = tuple(old[index] for index in retained[:-1])
            if anchors != new[:count - 1]:
                continue
            exact = unique.intersection(anchors)
            if len(exact) < 2 or not any(identity[0] == "incoming" for identity in exact):
                continue
            if old[-1] != new[count - 1] and not short_private_outgoing_ocr_drift(before[-1], after[count - 1]):
                continue
            aligned = tuple(zip((before[index] for index in retained), after[:count]))
            if share_vertical_shift(aligned):
                overlaps.append(count)
    return overlaps


def short_private_outgoing_ocr_drift(before, after) -> bool:
    if (before.direction != "outgoing" or after.direction != "outgoing" or before.sender != after.sender
            or before.identity[3:] != after.identity[3:]):
        return False
    left = "".join(key(before.text).split())
    right = "".join(key(after.text).split())
    return 17 <= len(left) == len(right) < 20 and sum(a != b for a, b in zip(left, right)) == 1


def older_private_ocr_drift(before: VisibleMessage, after: VisibleMessage) -> bool:
    if (before.direction != after.direction or before.sender != after.sender
            or before.identity[3:] != after.identity[3:]
            or (before.box[0], *before.box[2:]) != (after.box[0], *after.box[2:])):
        return False
    left = "".join(key(before.text).split())
    right = "".join(key(after.text).split())
    # Larger received cards can lose or misread a whole OCR line while moving.
    # The private caller already verified the exact anchor and shared geometry.
    large_incoming = before.direction == "incoming" and before.box[2] >= 180 and before.box[3] >= 72
    threshold = 0.79 if large_incoming else 0.92
    return min(len(left), len(right)) >= 35 and SequenceMatcher(None, left, right, autojunk=False).ratio() >= threshold


def select_quote(messages, sender: str, text: str) -> VisibleMessage | None:
    """Select only a unique incoming bubble matching the visible sender and text."""
    if not key(sender) or not key(text):
        return None
    matches = [message for message in messages if message.direction == "incoming"
               and key(message.sender) == key(sender) and key(message.text) == key(text)]
    return matches[0] if len(matches) == 1 else None
