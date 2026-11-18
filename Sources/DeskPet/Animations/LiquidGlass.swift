import SwiftUI

// P21 — Liquid Glass (macOS 26 / iOS 26+) helpers, with a graceful fallback to
// AppKit-style .regularMaterial + accent overlay on earlier OSes. The macOS 26
// SDK ships a real glass material (`.glassEffect(_:in:)`) that samples
// background pixels and refracts them through a per-view shape, with a tinted
// variant and an `identity` no-op for menus; macOS 14/15 get a hand-rolled
// approximation (a regular material + a 1-pt edge highlight + a soft tint) so
// the look is consistent across the deployment-target range.
//
// Every helper is `if #available(macOS 26, *)` gated so the macOS 14 build
// does not error on the new API symbols and so the visual intent is identical
// on both OSes.

/// Visual style for `liquidGlass(...)`. Maps to macOS 26's `GlassEffectStyle`.
enum LiquidGlassStyle: Sendable {
    case regular   // standard glass with subtle background sampling
    case clear     // higher transmission, less tint
    case tinted    // accent-tinted glass
}

// MARK: - Top-level modifier

extension View {
    /// Wrap the view in a Liquid Glass material. On macOS 26+ this calls
    /// SwiftUI's native `glassEffect(_:in:)`; on earlier OSes the view gets
    /// a regular material + 1-pt edge highlight + optional accent tint, so
    /// the visual is recognisable if not physically refracting.
    @ViewBuilder
    func liquidGlass(style: LiquidGlassStyle = .regular,
                     cornerRadius: CGFloat = DSRadius.regular,
                     tint: Color? = nil) -> some View {
        if #available(macOS 26, *) {
            applyLiquidGlassNative(style: style, cornerRadius: cornerRadius, tint: tint)
        } else {
            self
                .background {
                    LiquidGlassFallback(style: style, tint: tint)
                }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(LiquidGlassEdgeHighlight(cornerRadius: cornerRadius))
        }
    }

    /// Apply a Liquid Glass tint without the full material. Useful for chips
    /// and small surfaces where the underlying content is already opaque and
    /// only a coloured glaze is desired.
    @ViewBuilder
    func liquidGlassTint(_ color: Color, opacity: CGFloat = 0.10) -> some View {
        self.overlay {
            Rectangle()
                .fill(
                    LinearGradient(colors: [color.opacity(opacity * 1.4),
                                            color.opacity(opacity * 0.5),
                                            .clear],
                                   startPoint: .top,
                                   endPoint: .bottom)
                )
                .blendMode(.plusLighter)
                .allowsHitTesting(false)
        }
    }
}

/// Internal entry point that only compiles on macOS 26+. Splitting the API
/// like this keeps the macOS 14 type-checker from ever seeing the
/// `SwiftUICore.Glass` symbol.
@available(macOS 26, *)
extension View {
    fileprivate func applyLiquidGlassNative(style: LiquidGlassStyle,
                                            cornerRadius: CGFloat,
                                            tint: Color?) -> ModifiedContent<Self, LiquidGlassNativeModifier<RoundedRectangle>> {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let glass: SwiftUICore.Glass
        switch style {
        case .regular:
            glass = .regular
        case .clear:
            glass = .clear
        case .tinted:
            if let tint {
                glass = SwiftUICore.Glass.regular.tint(tint)
            } else {
                glass = .regular
            }
        }
        return self.modifier(LiquidGlassNativeModifier(glass: glass,
                                                      shape: shape,
                                                      edgeCornerRadius: cornerRadius))
    }
}

// MARK: - Edge highlight

/// A 1-pt top-edge specular line that runs along the inside of a glass
/// surface. On macOS 26+ it's redundant with the native glass highlight but
/// is harmless; on earlier OSes it carries the entire "polished glass" cue.
struct LiquidGlassEdgeHighlight: View {
    let cornerRadius: CGFloat
    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .strokeBorder(
                LinearGradient(colors: [.white.opacity(0.32),
                                        .white.opacity(0.04),
                                        .clear],
                               startPoint: .top, endPoint: .center),
                lineWidth: 0.5
            )
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
    }
}

// MARK: - macOS 26 native bridge

/// Internal wrapper that only compiles on macOS 26+. Used to keep the
/// `SwiftUICore.Glass` symbol out of the macOS 14 build path.
@available(macOS 26, *)
struct LiquidGlassNativeModifier<S: Shape>: ViewModifier {
    let glass: SwiftUICore.Glass
    let shape: S
    let edgeCornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .glassEffect(glass, in: shape)
            .overlay(LiquidGlassEdgeHighlight(cornerRadius: edgeCornerRadius))
    }
}

// MARK: - P22 macOS 26+ container batching

/// When several adjacent glass surfaces live in the same screen region
/// (nav rail + status pill, chat activity card stack, etc.) wrapping them
/// in a `GlassEffectContainer` lets the system batch the per-pixel blur
/// computation. On macOS 14/15 we just lay them out normally — the
/// fallback material is cheap enough that batching buys nothing.
extension View {
    @ViewBuilder
    func liquidGlassContainer(spacing: CGFloat = 0) -> some View {
        if #available(macOS 26, *) {
            SwiftUICore.GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}

// MARK: - Fallback material (macOS 14/15)

/// Hand-rolled approximation of the macOS 26 glass material for deployment
/// targets below 26. Uses `.regularMaterial` (which on macOS 14/15 already
/// samples the desktop wallpaper / window behind) and stacks a vertical
/// gradient on top to suggest a refractive top-light.
struct LiquidGlassFallback: View {
    let style: LiquidGlassStyle
    let tint: Color?

    var body: some View {
        ZStack {
            if style == .clear {
                // `.ultraThinMaterial` is the closest the older API has to "clear".
                Rectangle().fill(.ultraThinMaterial)
            } else {
                Rectangle().fill(.regularMaterial)
            }

            // Subtle top-light highlight simulating glass curvature
            LinearGradient(colors: [.white.opacity(0.18), .white.opacity(0.04), .clear],
                           startPoint: .top, endPoint: .center)

            if let tint {
                LinearGradient(colors: [tint.opacity(0.18), tint.opacity(0.05), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
    }
}

// MARK: - Tint overlay (shared)

/// A diagonal accent glaze that sits on top of any material to suggest the
/// "tinted" Liquid Glass variant. Used both as the fallback path and as an
/// extra sheen on the macOS 26 native glass for surfaces that need a more
/// pronounced brand colour.
struct LiquidGlassTintOverlay: View {
    let tint: Color
    let opacity: CGFloat

    var body: some View {
        LinearGradient(colors: [tint.opacity(opacity * 1.6),
                                tint.opacity(opacity * 0.6),
                                .clear,
                                tint.opacity(opacity * 0.3)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
    }
}

// MARK: - Refraction backdrop

/// Optional decoration for large glass surfaces. Renders a softly blurred
/// "behind-the-glass" content placeholder so the panel reads as transparent
/// even when the rest of the UI is opaque. Cheap (single `Canvas`).
struct LiquidGlassRefractionBackdrop: View {
    let seed: Int
    @State private var phase: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Canvas { ctx, size in
            // Stable pseudo-random offsets so the backdrop doesn't visibly shift
            // every frame.
            var rng = SeededRandom(seed: UInt64(seed))
            for _ in 0..<8 {
                let x = CGFloat(rng.next()) * size.width
                let y = CGFloat(rng.next()) * size.height
                let r = CGFloat(60 + rng.next() % 90)
                let circle = Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r))
                let opacity = 0.05 + Double(rng.next() % 6) / 100
                ctx.fill(circle, with: .color(.white.opacity(opacity)))
            }
        }
        .blur(radius: 24)
        .opacity(reduceMotion ? 1 : (0.85 + 0.15 * phase))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 6.0).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }
}

/// Tiny LCG so the refraction backdrop is deterministic per-view.
private struct SeededRandom {
    var state: UInt64
    init(seed: UInt64) { state = seed | 1 }
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (state >> 33) & 0xFFFF
    }
}
