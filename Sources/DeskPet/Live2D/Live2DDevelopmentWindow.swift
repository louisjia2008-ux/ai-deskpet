#if DEBUG
import AppKit
import WebKit

/// Phase-01 development coexistence inside the real DeskPet process. No failure fallback.
@MainActor
final class Live2DDevelopmentWindow: NSObject, NSWindowDelegate {
    private let window: NSWindow
    let bridge: Live2DBridge
    private let source: String
    private let evidence: URL?
    private var didExercise = false
    private var task: Task<Void,Never>?
    init(modelDirectory: URL, source: String, evidence: URL?) {
        self.source=source;self.evidence=evidence
        bridge=Live2DBridge(modelDirectory:modelDirectory)
        window=NSWindow(contentRect:NSRect(x:500,y:150,width:420,height:580),styleMask:[.borderless,.resizable],backing:.buffered,defer:false)
        super.init()
        window.isOpaque=false;window.backgroundColor = .clear;window.hasShadow=false
        window.isReleasedWhenClosed=false;window.level = .floating
        window.contentView=bridge.webView;window.delegate=self
        bridge.onEvent = { [weak self] event in self?.event(event) }
    }
    func show() {window.orderFrontRegardless();bridge.start();bridge.trackPointer()}
    func windowWillClose(_ notification: Notification) {task?.cancel();bridge.close()}
    private func event(_ event:Live2DEvent) {
        let row:[String:Any]=["time":Date().timeIntervalSince1970,"type":event.kind.rawValue,"id":event.id ?? "","payload":event.payload]
        if let evidence, let data=try? JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]) {
            try? FileManager.default.createDirectory(at:evidence,withIntermediateDirectories:true)
            let file=evidence.appendingPathComponent("events.jsonl")
            if !FileManager.default.fileExists(atPath:file.path){FileManager.default.createFile(atPath:file.path,contents:nil)}
            if let handle=try? FileHandle(forWritingTo:file){defer{try? handle.close()};_ = try? handle.seekToEnd();try? handle.write(contentsOf:data+Data([10]))}
        }
        if event.kind == .runtimeReady {bridge.send(.load,["source":source])}
        if event.kind == .modelLoaded, !didExercise, evidence != nil {
            didExercise=true
            task=Task { [weak self] in await self?.exercise(event.payload) }
        }
    }
    private func delay(_ seconds: Double) async {try? await Task.sleep(for:.seconds(seconds))}
    private func capture(_ name:String) async {
        guard let evidence else{return}
        do {let image=try await bridge.webView.takeSnapshot(configuration:nil)
            if let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) {try png.write(to:evidence.appendingPathComponent(name+".png"))}
        }catch{event(Live2DEvent(kind:.runtimeError,id:nil,payload:["message":"snapshot: \(error)"]))}
    }
    private func exercise(_ capabilities:[String:Any]) async {
        bridge.stopTrackingPointer()
        bridge.send(.focus,["x":0,"y":0,"active":false])
        for index in 0..<36 {await delay(0.25);bridge.send(.capabilities);if index % 4 == 0 {await capture("idle-\(index)")}}
        await capture("01-idle")
        bridge.send(.focus,["x":-1,"y":1,"active":true]);await delay(1);await capture("focus-left")
        bridge.send(.focus,["x":1,"y":-1,"active":true]);await delay(1);await capture("focus-right")
        bridge.send(.view,["scale":0.8,"x":10,"y":-10]);await delay(1);await capture("view-offset")
        bridge.send(.view,["scale":1,"x":0,"y":0]);bridge.trackPointer()
        bridge.setState(Live2DCharacterState(speaking:true,mouthOpenness:1));await delay(1);await capture("02-mouth-open")
        bridge.setState(Live2DCharacterState());await delay(1);await capture("03-mouth-closed")
        if let names=capabilities["expressions"] as? [String],let first=names.first {bridge.send(.expression,["name":first]);await delay(1);await capture("04-expression");bridge.send(.clearExpression)}
        if let motions=capabilities["motions"] as? [[String:Any]],let motion=motions.last {bridge.send(.motion,motion)}
        await delay(3);bridge.send(.pause);await delay(1);await capture("05-paused");bridge.send(.capabilities);bridge.send(.resume)
        window.setContentSize(NSSize(width:360,height:480));await delay(1);await capture("06-resize")
        // Data-driven hit tests across the actual canvas; only model-defined areas emit events.
        for x in stride(from:30,through:330,by:60){for y in stride(from:30,through:450,by:60){bridge.send(.hitTest,["x":x,"y":y])}}
        await delay(2);bridge.send(.load,["source":"deskpet://models/missing.model3.json"])
        await delay(2);bridge.send(.load,["source":"https://invalid.example/model.model3.json"])
        await delay(1);bridge.send(.load,["source":"deskpet://models/invalid.model3.json"])
        await delay(2);bridge.reload();await delay(4);await capture("07-reloaded");bridge.send(.capabilities)
    }
}
#endif
