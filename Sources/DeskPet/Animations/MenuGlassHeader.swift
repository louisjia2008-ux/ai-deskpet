import AppKit
import SwiftUI

// P22 — Liquid Glass menu header. macOS 26 NSMenu already uses a native glass
// material for the panel background; the brand-specific polish is a custom
// glass header view (logo + app name + current status pill) injected as the
// menu's first item. The header is rendered with NSHostingView so the SwiftUI
// Liquid Glass modifiers compose normally.

struct MenuGlassHeader: View {
    let appName: String
    let subtitle: String
    let statusText: String?
    let statusTint: Color

    var body: some View {
        HStack(spacing: DSSpacing.s) {
            Image(systemName: "pawprint.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(DSColor.primaryAccent)
                .frame(width: 28, height: 28)
                .liquidGlass(style: .tinted,
                             cornerRadius: 14,
                             tint: DSColor.primaryAccent)

            VStack(alignment: .leading, spacing: 1) {
                Text(appName)
                    .font(DSFont.cardTitle)
                    .foregroundStyle(DSColor.textPrimary)
                Text(subtitle)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: DSSpacing.s)

            if let statusText {
                StatusPill(text: statusText, tint: statusTint)
            }
        }
        .padding(.horizontal, DSSpacing.m)
        .padding(.vertical, DSSpacing.s)
        .frame(width: 320)
    }
}

/// AppKit bridge: hosts the SwiftUI glass header in an NSMenuItem view.
@MainActor
enum MenuGlassHeaderBridge {
    /// Build an NSMenuItem whose `view` is a hosting view of the glass
    /// header. The menu item is non-selectable (the user can't click the
    /// brand area) and matches the menu panel width.
    static func makeMenuItem(appName: String = "DeskPet",
                             subtitle: String = "Companion Console",
                             statusText: String? = nil,
                             statusTint: Color = DSColor.success) -> NSMenuItem {
        let header = MenuGlassHeader(appName: appName,
                                     subtitle: subtitle,
                                     statusText: statusText,
                                     statusTint: statusTint)
        let host = NSHostingView(rootView: AnyView(header))
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 56)
        // Match the host's appearance so DSColor token resolution
        // (light/dark) lands in sync with the menu panel.
        host.appearance = NSAppearance(named: .aqua)
        let item = NSMenuItem()
        item.view = host
        item.isEnabled = false
        return item
    }
}
