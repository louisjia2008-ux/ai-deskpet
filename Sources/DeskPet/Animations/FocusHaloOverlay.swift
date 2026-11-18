import SwiftUI

// P20 / #6 + P21 — focus session screen-edge halo. While a focus session is
// active the timer card pulses a soft accent ring + a breathing glow that
// grows from the centre outward and fades back. P21 layers a liquid-glass
// sheen (tint + edge highlight + soft inner refraction) so the halo reads
// as a polished surface rather than a flat ring. Reduce Motion collapses to
// a static border.

struct FocusHaloOverlay: View {
    let isActive: Bool
    let tint: Color
    let reduceMotion: Bool
    @State private var phase: CGFloat = 0

    var body: some View {
        ZStack {
            // Outer ring (4-pt stroke, full perimeter of the card)
            RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous)
                .stroke(tint.opacity(isActive ? 0.32 + 0.18 * phase : 0),
                        lineWidth: 3)
                .padding(-2)
                .blur(radius: 0.6)

            // Soft inner glow
            RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous)
                .fill(
                    RadialGradient(colors: [tint.opacity(0.18 + 0.10 * phase),
                                            .clear],
                                   center: .center,
                                   startRadius: 40,
                                   endRadius: 320)
                )
                .blendMode(.plusLighter)
                .opacity(isActive ? 1 : 0)

            // P21 — liquid glass tint glaze: a diagonal accent wash that
            // suggests refraction through the card surface. Subtle enough
            // to layer with the breathing ring without overpowering it.
            if isActive {
                LiquidGlassTintOverlay(tint: tint, opacity: 0.05 + 0.04 * phase)
                    .opacity(isActive ? 1 : 0)
            }

            // P21 — 1-pt specular edge highlight that strengthens during the
            // breathing cycle so the card edge appears to catch the light.
            LiquidGlassEdgeHighlight(cornerRadius: DSRadius.card)
                .opacity(isActive ? 0.6 + 0.4 * phase : 0)
        }
        .allowsHitTesting(false)
        .onChange(of: isActive) { _, newValue in
            if newValue && !reduceMotion {
                withAnimation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true)) {
                    phase = 1
                }
            } else {
                phase = 0
            }
        }
    }
}
