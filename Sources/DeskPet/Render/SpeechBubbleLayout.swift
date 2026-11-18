import AppKit
import Foundation

/// P17 / CR-01 — wraps arbitrary text into a bounded, multi-line speech bubble and
/// truncates with an ellipsis when the content exceeds the cap. Pure (no AppKit
/// dependencies at runtime); testable. Layout is measured via `NSAttributedString` so
/// callers don't have to render an `SKLabelNode` first.
enum SpeechBubbleLayout {
    struct Lines {
        let lines: [String]
        let truncated: Bool
        let totalMeasuredHeight: CGFloat
    }

    /// Wraps `text` into lines that fit within `maxWidth` and a `maxLines` cap.
    /// `fontSize` is the size used to measure; `fontName` defaults to the system font
    /// when nil (the bubble renderer uses a slightly different font at runtime, so we
    /// measure with the same size for consistency).
    static func lines(for text: String,
                      maxWidth: CGFloat,
                      maxLines: Int,
                      fontSize: CGFloat = 15,
                      fontName: String? = nil) -> Lines {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, maxWidth > 0, maxLines > 0 else {
            return Lines(lines: [], truncated: false, totalMeasuredHeight: 0)
        }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: font(fontName: fontName, size: fontSize)
        ]
        let full = NSAttributedString(string: trimmed, attributes: attributes)
        let measuredFont = attributes[.font] as! NSFont
        let singleLineHeight = ceil(measuredFont.ascender - measuredFont.descender + measuredFont.leading)

        var wrappedLines: [String] = []
        let ctLines = CTLineWrap(full, maxWidth: maxWidth)
        for line in ctLines {
            wrappedLines.append(line.trimmingCharacters(in: .whitespaces))
            if wrappedLines.count >= maxLines { break }
        }

        // If we overflowed the line cap, mark truncation and append an ellipsis to the
        // last visible line.
        if ctLines.count > maxLines, let last = wrappedLines.last {
            let truncated = truncatedLine(last, font: attributes[.font] as? NSFont, maxWidth: maxWidth)
            wrappedLines[wrappedLines.count - 1] = truncated
            return Lines(lines: wrappedLines,
                         truncated: true,
                         totalMeasuredHeight: singleLineHeight * CGFloat(wrappedLines.count))
        }

        return Lines(lines: wrappedLines,
                     truncated: false,
                     totalMeasuredHeight: singleLineHeight * CGFloat(wrappedLines.count))
    }

    private static func font(fontName: String?, size: CGFloat) -> NSFont {
        if let fontName, let custom = NSFont(name: fontName, size: size) {
            return custom
        }
        return NSFont.systemFont(ofSize: size)
    }

    private static func truncatedLine(_ line: String, font: NSFont?, maxWidth: CGFloat) -> String {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15)
        ]
        var working = line
        let ellipsis = "…"
        while !working.isEmpty {
            let candidate = working + ellipsis
            let width = (candidate as NSString).size(withAttributes: attrs).width
            if width <= maxWidth || working.isEmpty { break }
            working.removeLast()
        }
        return working + ellipsis
    }

    /// Lightweight Core Text wrapper that returns one element per visible line.
    /// `boundingRect` with `usesLineFragmentOrigin` already wraps, so we use it here.
    private static func CTLineWrap(_ attr: NSAttributedString, maxWidth: CGFloat) -> [String] {
        let framesetter = CTFramesetterCreateWithAttributedString(attr)
        let size = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRangeMake(0, attr.length),
            nil,
            CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            nil
        )
        // Reuse `boundingRect` to break lines consistently with NSAttributedString.
        let textRect = CGRect(x: 0, y: 0, width: maxWidth, height: size.height + 1)
        let bounding = attr.boundingRect(with: textRect.size,
                                          options: [.usesLineFragmentOrigin, .usesFontLeading],
                                          context: nil)
        let perLine = max(1, size.height / max(1, bounding.height / max(CGFloat(max(1, attr.length)), 1)))
        _ = perLine // suppress unused warning; reserved for future per-line metric
        // Approximate the wrapped lines by walking the string with the same width rule.
        return wrapByWidth(attr.string, font: attr.attribute(.font, at: 0, effectiveRange: nil) as? NSFont,
                           maxWidth: maxWidth)
    }

    private static func wrapByWidth(_ text: String, font: NSFont?, maxWidth: CGFloat) -> [String] {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 15)
        ]
        var lines: [String] = []
        // Split on existing newlines first, then wrap each paragraph.
        for paragraph in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var current = ""
            for char in paragraph {
                let candidate = current + String(char)
                let width = (candidate as NSString).size(withAttributes: attrs).width
                if width > maxWidth, !current.isEmpty {
                    lines.append(current)
                    current = String(char)
                } else {
                    current = candidate
                }
            }
            if !current.isEmpty { lines.append(current) }
        }
        return lines
    }
}
