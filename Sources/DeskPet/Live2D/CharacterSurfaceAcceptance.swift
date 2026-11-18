#if DEBUG
import AppKit
import WebKit
import ApplicationServices

/// Exercises the actual canonical surface. It never selects a renderer or creates another view.
@MainActor
extension CharacterSurface {
    func runAcceptance(at directory: URL, soakSeconds: Double = 1800) async {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        func write(_ name: String, _ value: [String: Any]) {
            if let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.prettyPrinted]) {
                try? data.write(to:directory.appendingPathComponent(name+".json"))
            }
        }
        func delay(_ seconds: Double) async { try? await Task.sleep(for:.seconds(seconds)) }
        func capture(_ name: String) async {
            // App-owned native compositing evidence; this does not capture the desktop or underlying apps.
            if let bitmap = bitmapImageRepForCachingDisplay(in: bounds) {
                cacheDisplay(in: bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: directory.appendingPathComponent(name + "-native-surface.png"))
                }
            }
            for (label,host) in [("host",host)] {
                do {
                    let image = try await host.bridge.webView.takeSnapshot(configuration:nil)
                    if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data:tiff), let data = rep.representation(using:.png,properties:[:]) {
                        try data.write(to:directory.appendingPathComponent(name+"-"+label+".png"))
                    }
                } catch { write(name+"-"+label+"-error",["error":error.localizedDescription]) }
            }
        }
        for (label,host) in [("host",host)] {
            host.onEvent = { event in
                let row: [String:Any] = ["time":Date().timeIntervalSince1970,"instance":label,"type":event.kind.rawValue,"payload":event.payload]
                guard let data = try? JSONSerialization.data(withJSONObject:row,options:.sortedKeys) else { return }
                let file = directory.appendingPathComponent("events.jsonl")
                if !fm.fileExists(atPath:file.path) { fm.createFile(atPath:file.path,contents:nil) }
                if let h = try? FileHandle(forWritingTo:file) { defer { try? h.close() }; _ = try? h.seekToEnd(); try? h.write(contentsOf:data+Data([10])) }
            }
        }
        host.occupancyCaptureEnabled = !ProcessInfo.processInfo.arguments.contains("--live2d-no-occupancy")
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--canonical-import-zip"), args.indices.contains(index + 1) {
            let source = args[index + 1]
            do { try importModel(from: URL(fileURLWithPath: source)) }
            catch { write("import-error", ["message": error.localizedDescription]) }
        }
        let deadline = Date().addingTimeInterval(20)
        while !host.loaded, Date() < deadline { await delay(0.1) }
        write("launch",["renderer":Self.rendererIdentity,"pid":ProcessInfo.processInfo.processIdentifier,"hostCount":1,"bridgeCount":1,"webViewCount":subviews.filter { $0 is WKWebView }.count,"backingScale":window?.backingScaleFactor ?? 0,"hostLoaded":host.loaded,
                        "pointerRoutingAccessibilityTrusted":AXIsProcessTrusted(), "pointerRoutingListenAccess":CGPreflightListenEventAccess(), "pointerRoutingPostAccess":CGPreflightPostEventAccess(),
                        "hostError":host.error ?? "", "window":String(describing:window?.frame),
                        "hostFrame":NSStringFromRect(host.frame),
                        "hostBounds":NSStringFromRect(host.visualBounds)])
        await capture("01-launch")
        if ProcessInfo.processInfo.arguments.contains("--canonical-measure-only") {
            let start = Date()
            while Date().timeIntervalSince(start) < soakSeconds {
                host.bridge.send(.capabilities); await delay(5)
            }
            write("soak-complete", ["seconds":Date().timeIntervalSince(start),"hostLoaded":host.loaded])
            return
        }
        guard host.loaded else { return }
        showBubble("Live2D 桌面角色验收：原生气泡")
        await delay(1)
        write("bubble",["anchor":NSStringFromPoint(bubbleAnchor)])
        setSpeakingLevel(1); await delay(1); await capture("02-mouth-open")
        setSpeakingLevel(0); await delay(1); await capture("03-mouth-closed")
        if let expression = host.capabilities.expressions.first { host.bridge.send(.expression,["name":expression]) }
        if let motion = host.capabilities.motions.last { host.bridge.send(.motion,["group":motion.group,"index":motion.index]) }
        await delay(2); await capture("04-expression-motion")
        host.bridge.send(.clearExpression)
        for x in stride(from:Double(host.frame.minX+5),to:Double(host.frame.maxX),by:10) {
            for y in stride(from:Double(host.frame.minY+5),to:Double(host.frame.maxY),by:10) {
                host.sendHit(CGPoint(x:x,y:y))
            }
        }
        hideBubble()
        var reloads: [[String:Any]] = []
        for index in 0..<50 {
            let start = Date()
            host.reload(selection:host.selection)
            let timeout = Date().addingTimeInterval(15)
            while !host.loaded, Date() < timeout { await delay(0.1) }
            host.bridge.send(.capabilities)
            reloads.append(["index":index,"host":host.loaded,"elapsed":Date().timeIntervalSince(start)])
            if !host.loaded { break }
        }
        write("reloads",["iterations":reloads])
        await capture("05-after-reloads")
        NSApp.hide(nil)
        await delay(1)
        host.bridge.send(.capabilities)
        write("application-hidden",["isHidden":NSApp.isHidden,"hostSuspended":host.bridge.suspended])
        NSApp.unhide(nil)
        await delay(1)
        host.bridge.send(.capabilities)
        write("application-shown",["isHidden":NSApp.isHidden,"hostSuspended":host.bridge.suspended])
        setVisible(false,animated:false); await delay(1)
        host.bridge.send(.capabilities)
        write("surface-hidden",["hidden":isHidden,"hostSuspended":host.bridge.suspended])
        setVisible(true,animated:false); await delay(1)
        write("surface-shown",["hidden":isHidden,"hostSuspended":host.bridge.suspended])
        let saved = host.selection
        host.reload(selection:CharacterModelSelection(identity:"missing test fixture",relativePath:"missing.model3.json"))
        await delay(1); write("missing-model",["loaded":host.loaded,"explicitError":host.error ?? ""])
        host.reload(selection:CharacterModelSelection(identity:"malformed test fixture",relativePath:"invalid.model3.json"))
        await delay(2)
        write("malformed-model",["loaded":host.loaded,"explicitError":host.error ?? ""])
        host.reload(selection:saved)
        let restored = Date().addingTimeInterval(15)
        while !host.loaded, Date() < restored { await delay(0.1) }
        setSpeakingLevel(1); await delay(1)
        host.reload(selection:saved)
        let speechReloadDeadline = Date().addingTimeInterval(15)
        while !host.loaded, Date() < speechReloadDeadline { await delay(0.1) }
        await delay(1); host.bridge.send(.capabilities)
        await capture("speech-replayed-after-reload")
        setSpeakingLevel(0)
        // Diagnostic experiment only; production remains at its existing 30 FPS cap.
        host.bridge.send(.fps,["fps":15])
        await delay(60); host.bridge.send(.capabilities)
        await capture("idle-15fps")
        host.bridge.send(.fps,["fps":30])
        write("exercise-complete",["time":Date().timeIntervalSince1970,"hostLoaded":host.loaded])
        // Real bounded sampling, not extrapolated. No task/provider execution is involved.
        let start = Date()
        for _ in 0..<Int(ceil(max(0,min(3600,soakSeconds))/10)) {
            host.bridge.send(.capabilities)
            await delay(10)
            if Task.isCancelled { break }
        }
        write("soak-complete",["seconds":Date().timeIntervalSince(start),"hostLoaded":host.loaded])
        await capture("06-after-soak")
    }
}
#endif
