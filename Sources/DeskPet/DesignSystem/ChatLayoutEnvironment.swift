import SwiftUI

// P19.5 — chat column width environment key.
//
// Production chat message areas (ChatExpandedView.messageArea,
// CompanionChatView's conversation column) inject the **measured column width**
// into the SwiftUI environment so `MessageBubble` can derive its max bubble
// width from the container, not from a top-level `GeometryReader`.
//
// Why a separate env value? `MessageBubble` previously wrapped its body in a
// `GeometryReader` to read `proxy.size.width`. Inside a `LazyVStack` inside a
// `ScrollView` the GeometryReader reported its size back to the LazyVStack as
// `(_, .infinity)`, which broke the LazyVStack's vertical stacking: every
// MessageBubble ended up at the same y-coordinate (top of scroll content)
// producing the visible defect where a long reply bubble's text overlapped
// the user/assistant messages that follow it. See
// `review/p19_5_chat_responsive_20260903_143800/01_root_cause/P19_5_CHAT_OVERFLOW_ROOT_CAUSE.md`.
//
// By moving the column-width read to a **bounded** GeometryReader in the message
// area (which IS given a bounded parent by the outer VStack + .frame chain),
// and threading that measurement down via a SwiftUI env value, the per-bubble
// GeometryReader is no longer needed. MessageBubble now reports its **true
// intrinsic content height** to the LazyVStack, so messages stack at distinct
// y-coordinates as expected.
//
// `containerRelativeFrame(.horizontal)` would be a SwiftUI-native alternative,
// but it returns the bounding container's width — for chat we want the
// **message column** width (which excludes the panel's padding). An explicit
// env value keeps the contract obvious and testable.
//
// The default value is the readable cap (560pt) so a `MessageBubble` rendered
// without a chat column (isolated previews, single-bubble tests) still looks
// like a bubble instead of collapsing to ~1pt.

/// P19.5 / R-CHAT-OVERFLOW — chat column width environment key.
private struct ChatColumnWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = 560
}

extension EnvironmentValues {
    /// The available width of the message column the bubble is being rendered
    /// into. Set by `ChatExpandedView.messageArea` and by the production
    /// `CompanionChatView` conversation column. Default 560 (the readable
    /// cap) so isolated previews still look right.
    var chatColumnWidth: CGFloat {
        get { self[ChatColumnWidthKey.self] }
        set { self[ChatColumnWidthKey.self] = newValue }
    }
}
