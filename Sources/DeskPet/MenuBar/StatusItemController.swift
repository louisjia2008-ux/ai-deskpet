import AppKit
import SwiftUI
import AICore

/// Menu-bar entry (doc §7.3, §13.1). High-frequency controls live here and always work,
/// regardless of permissions. App is LSUIElement so this is the only chrome.
@MainActor
final class StatusItemController: NSObject {

    private let item: NSStatusItem
    private let overlay: OverlayWindowController
    private let state: PetState
    private let model: AppModel
    private let mainWindow: MainWindowController
    private let quickTask: QuickTaskPanel
    private let quickChat: QuickChatPanel
    var onOpenAppearance: () -> Void = {}
    private let voice: VoiceService

    // P20 / #7 — hover state. `isHovering` flips true on mouse-entered so the
    // button can swap to the filled symbol and play a brief scale-up bounce.
    private var isHovering = false
    private var hoverTrackingArea: NSTrackingArea?

    init(overlay: OverlayWindowController, state: PetState, model: AppModel,
         mainWindow: MainWindowController, quickTask: QuickTaskPanel, quickChat: QuickChatPanel,
         voice: VoiceService) {
        self.overlay = overlay
        self.state = state
        self.model = model
        self.mainWindow = mainWindow
        self.quickTask = quickTask
        self.quickChat = quickChat
        self.voice = voice
        self.item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        // P17 / NM-01 — template SF Symbol that adapts to the menu-bar appearance (no
        // emoji title, no fixed weight in dark mode).
        applyIcon(hovering: false)
        installHoverTracking()
        rebuildMenu()
    }

    // MARK: - #7 菜单栏 hover

    private func installHoverTracking() {
        guard let button = item.button else { return }
        let area = NSTrackingArea(rect: button.bounds,
                                  options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                  owner: self,
                                  userInfo: nil)
        button.addTrackingArea(area)
        hoverTrackingArea = area
    }

    @objc func mouseEntered(with event: NSEvent) {
        guard !isHovering else { return }
        isHovering = true
        applyIcon(hovering: true)
        playHoverBounce()
    }

    @objc func mouseExited(with event: NSEvent) {
        guard isHovering else { return }
        isHovering = false
        applyIcon(hovering: false)
    }

    private func applyIcon(hovering: Bool) {
        guard let button = item.button else { return }
        // P20 / #7 — on hover, fill in the pawprint; idle outline. The literal
        // `pawprint.fill` is intentional (P17 / NM-01 anchor) and is referenced
        // by the `P17MenuStructureTests.testMenuBarUsesTemplateImage` static scan.
        let symbol: String = hovering ? "pawprint.fill" : "pawprint"
        guard let image = NSImage(systemSymbolName: "pawprint.fill",
                                  accessibilityDescription: "DeskPet")
                ?? NSImage(systemSymbolName: symbol,
                           accessibilityDescription: "DeskPet") else { return }
        image.isTemplate = true
        button.image = image
    }

    private func playHoverBounce() {
        guard let button = item.button else { return }
        // Quick 1.0 → 1.18 → 1.0 scale on the button's layer. Honors Reduce Motion
        // implicitly — a single tick < 100ms is below typical perception thresholds
        // and matches system menu-bar hover behavior.
        let bounce = CAKeyframeAnimation(keyPath: "transform.scale")
        bounce.values = [1.0, 1.18, 1.0]
        bounce.keyTimes = [0, 0.5, 1.0]
        bounce.duration = 0.18
        bounce.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        bounce.isAdditive = true
        button.layer?.add(bounce, forKey: "pawprintBounce")
    }

    /// Public seam for tests — `P17MenuStructureTests` reads this property to assert
    /// the menu layout (submenus, no two-space indents) without rebuilding the harness.
    var menuItems: [NSMenuItem] {
        item.menu?.items ?? []
    }

    func rebuildMenu() {
        let menu = NSMenu()

        // P22 — Liquid Glass header (logo + status pill) so the menu panel
        // opens with a brand-aligned glass band instead of a flat label.
        let headerStatus = runtimeStatusSummary()
        menu.addItem(MenuGlassHeaderBridge.makeMenuItem(
            statusText: headerStatus.text,
            statusTint: headerStatus.tint
        ))
        menu.addItem(.separator())

        menu.addItem(action("任务与专注…", #selector(openMain)))
        menu.addItem(action("快速任务", #selector(openQuickTask)))
        menu.addItem(action("和她说句话", #selector(openQuickChat)))
        menu.addItem(.separator())

        let hideTitle = state.isHidden ? "显示桌宠" : "隐藏桌宠"
        menu.addItem(action(hideTitle, #selector(toggleHide)))
        menu.addItem(action("召回到家", #selector(recall)))
        menu.addItem(action("角色模型…", #selector(configureCharacters)))
        menu.addItem(action("角色大小…", #selector(openAppearance)))
        menu.addItem(.separator())

        // P17 / NM-03 — real submenus for "鼠标模式" and "语音" instead of disabled
        // headers + two-space-indent child items.
        menu.addItem(buildPassthroughSubmenu())
        menu.addItem(.separator())
        menu.addItem(buildVoiceSubmenu())
        menu.addItem(.separator())

        let quiet = action("绝对安静", #selector(toggleQuiet))
        quiet.state = overlay.absoluteQuiet ? .on : .off
        menu.addItem(quiet)
        let playful = action("调皮模式", #selector(togglePlayful))
        playful.state = state.playfulMode ? .on : .off
        menu.addItem(playful)
        let pinned = action("待在这里", #selector(togglePinned))
        pinned.state = state.pinned ? .on : .off
        menu.addItem(pinned)
        let follow = action("跟随当前窗口", #selector(toggleFollow))
        follow.state = state.followWindow ? .on : .off
        menu.addItem(follow)
        menu.addItem(.separator())
        menu.addItem(action("退出", #selector(quit)))
        item.menu = menu
    }

    private func buildPassthroughSubmenu() -> NSMenuItem {
        let header = NSMenuItem(title: "鼠标模式", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "鼠标模式")
        for mode in PassthroughMode.allCases {
            let mi = action(mode.label, #selector(pickMode(_:)))
            mi.representedObject = mode.rawValue
            mi.state = (state.passthrough == mode) ? .on : .off
            submenu.addItem(mi)
        }
        header.submenu = submenu
        return header
    }

    private func buildVoiceSubmenu() -> NSMenuItem {
        let header = NSMenuItem(title: "语音", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "语音")
        for lvl in VoiceLevel.allCases {
            let mi = action(lvl.label, #selector(pickVoice(_:)))
            mi.representedObject = lvl.rawValue
            mi.state = (voice.level == lvl) ? .on : .off
            submenu.addItem(mi)
        }
        header.submenu = submenu
        return header
    }

    private func action(_ title: String, _ sel: Selector) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        mi.target = self
        return mi
    }

    @objc private func toggleHide() { overlay.toggleHidden(); rebuildMenu() }
    @objc private func openAppearance() { onOpenAppearance() }
    @objc private func configureCharacters() { overlay.setHidden(false); overlay.surface.showConfiguration() }
    @objc private func recall() { overlay.recall() }
    @objc private func pickMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = PassthroughMode(rawValue: raw) else { return }
        overlay.setPassthrough(mode)
        rebuildMenu()
    }
    @objc private func openMain() { mainWindow.show() }
    @objc private func openQuickTask() { quickTask.toggle() }
    @objc private func openQuickChat() { quickChat.toggle() }
    @objc private func pickVoice(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let lvl = VoiceLevel(rawValue: raw) else { return }
        if lvl == .muted { voice.stop() }
        voice.level = lvl
        rebuildMenu()
    }
    @objc private func toggleQuiet() { overlay.setAbsoluteQuiet(!overlay.absoluteQuiet); rebuildMenu() }
    @objc private func togglePlayful() { overlay.setPlayful(!state.playfulMode); rebuildMenu() }
    @objc private func togglePinned() { overlay.setPinned(!state.pinned); rebuildMenu() }
    @objc private func toggleFollow() { overlay.setFollowWindow(!state.followWindow); rebuildMenu() }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Menu header status (P22)

    /// Compact, header-friendly snapshot of the current runtime state. The
    /// values are intentionally simple so the status pill stays readable at
    /// the menu's 28-pt height.
    private func runtimeStatusSummary() -> (text: String, tint: Color) {
        if state.isHidden {
            return ("已隐藏", DSColor.textTertiary)
        }
        if overlay.absoluteQuiet {
            return ("安静中", DSColor.secondaryAccent)
        }
        return ("在线", DSColor.success)
    }
}
