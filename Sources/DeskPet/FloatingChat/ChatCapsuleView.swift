import SwiftUI

struct ChatCapsuleView: View {
    @ObservedObject var store: FloatingChatStateStore
    var onExpand: () -> Void
    var onDragChanged: (CGSize) -> Void
    var onDragEnded: (CGSize) -> Void

    // P20 / #4 — hero animation state. `tapPulse` is briefly non-zero on tap to
    // squash the capsule; `ringPhase` drives an expanding glow ring so the eye
    // is led from the small capsule toward the upcoming expanded panel.
    @State private var tapPulse: CGFloat = 0
    @State private var ringPhase: CGFloat = 0
    @State private var ringOpacity: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: DSSpacing.s) {
            Image(systemName: "sparkle.magnifyingglass")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(DSColor.primaryAccent)
                .frame(width: 22, height: 22)
                .accessibilityHidden(true)

            Text("问我点什么…")
                .font(DSFont.body)
                .foregroundStyle(DSColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 96, alignment: .leading)

            Spacer(minLength: DSSpacing.xs)

            Text(store.modelBadge)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textSecondary)
                .lineLimit(1)
                // P17 / R1-21 — middle truncation avoids the model-name getting clipped
                // at the right edge while the provider name remains visible.
                .truncationMode(.middle)
                .layoutPriority(1)
                .padding(.horizontal, DSSpacing.s)
                .padding(.vertical, 3)
                .background(DSColor.token(.secondaryAccent).opacity(0.16), in: Capsule())
        }
        .padding(.horizontal, DSSpacing.m)
        .padding(.vertical, DSSpacing.s)
        .frame(width: 260, height: 46)
        // P21 — liquid glass capsule: macOS 26+ uses the native glass material;
        // older OSes get a regular material + accent overlay so the surface
        // still reads as a translucent pill.
        .liquidGlass(style: .tinted,
                     cornerRadius: 23,
                     tint: DSColor.primaryAccent)
        // P20 / #4 — the hero glow ring expands from the capsule center on tap,
        // signaling the upcoming window expand without depending on the NSWindow
        // frame animator (which only animates the *target* frame, not the source).
        .overlay {
            Capsule()
                .strokeBorder(DSColor.primaryAccent, lineWidth: 1.5)
                .scaleEffect(1.0 + 0.6 * ringPhase)
                .opacity(ringOpacity)
        }
        .shadow(color: .black.opacity(0.16), radius: 14, x: 0, y: 8)
        .scaleEffect(1.0 - 0.04 * tapPulse, anchor: .center)
        .opacity(store.visibilityState == .capsuleIdle ? 0.92 : 1)
        .contentShape(Capsule())
        .onTapGesture {
            playHero()
            store.expand()
            onExpand()
        }
        .simultaneousGesture(dragGesture)
        .onHover { hovering in
            if hovering {
                store.activateCapsule()
            } else {
                store.deactivateCapsule()
            }
        }
        .help("点击打开，拖动移动")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("打开或移动桌宠聊天")
        .accessibilityAddTraits(.isButton)
    }

    private func playHero() {
        if reduceMotion { return }
        // squash 1.0 → 0.96 → 1.0 (≈140ms each way)
        withAnimation(.easeOut(duration: 0.14)) { tapPulse = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { tapPulse = 0 }
        }
        // ring 1.0 → 1.6 with opacity 0.6 → 0 over 0.45s
        ringPhase = 0
        ringOpacity = 0.6
        withAnimation(.easeOut(duration: 0.45)) {
            ringPhase = 1
            ringOpacity = 0
        }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { value in
                store.markUserActivity()
                onDragChanged(value.translation)
            }
            .onEnded { value in
                store.markUserActivity()
                onDragEnded(value.translation)
            }
    }
}
