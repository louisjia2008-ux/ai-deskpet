import AppKit
import Vision
import AICore
import os

/// P18 — Screen-reader abstraction seam. Allows tests to inject a deterministic
/// capture path without invoking Vision / CGDisplayCreateImage. Production wires
/// `ScreenReader` directly.
@MainActor
public protocol ScreenReaderProviding: AnyObject {
    func read(consent: Bool) async -> String?
    func replacePolicy(_ newPolicy: @escaping () -> PerceptionPolicy)
}

/// L3 screen understanding (doc §11.4/§11.5). Runs ONLY on an explicit, per-use request. It
/// captures the focused display once, OCRs it, returns the text, and discards the image — the
/// screenshot is never stored and the text is never written to memory or the chat DB (the caller
/// uses it ephemerally). Degrades to nil without Screen Recording permission (doc §14.2).
@MainActor
public final class ScreenReader: ScreenReaderProviding {

    private var policy: () -> PerceptionPolicy
    private let logger = Logger(subsystem: "ai.deskpet.awareness", category: "screenreader")
    public init(policy: @escaping () -> PerceptionPolicy) { self.policy = policy }

    /// P18 — Replace the policy closure (used by `DesktopAwarenessService` when the
    /// authoritative perception policy moves from `ChatModel.perception` to the
    /// service). Safe to call repeatedly; the next `read(consent:)` consults the
    /// replacement.
    public func replacePolicy(_ newPolicy: @escaping () -> PerceptionPolicy) {
        policy = newPolicy
    }

    /// `consent` must be a fresh, explicit user action for THIS read (doc §11.5).
    /// Audit: logs only consent + char count, never content. The image is
    /// discarded on return; callers must treat the text as ephemeral (never persist).
    public func read(consent: Bool) async -> String? {
        guard policy().canReadScreen(explicitConsent: consent) else { return nil }
        guard consent else {
            logger.info("screen read denied: no explicit consent")
            return nil
        }
        guard let cg = captureMainDisplay() else { return nil }
        let text = await recognizeText(in: SendableImage(cg: cg))
        // `cg` goes out of scope here — the image is never persisted (doc §11.5).
        if let text {
            logger.info("screen read ok chars=\(text.count)")
        }
        return text
    }

    private func captureMainDisplay() -> CGImage? {
        let id = CGMainDisplayID()
        return CGDisplayCreateImage(id)   // returns nil without Screen Recording permission
    }

    private nonisolated func recognizeText(in image: SendableImage) async -> String? {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNRecognizeTextRequest { req, _ in
                    let lines = (req.results as? [VNRecognizedTextObservation])?
                        .compactMap { $0.topCandidates(1).first?.string } ?? []
                    let joined = lines.joined(separator: "\n")
                    cont.resume(returning: joined.isEmpty ? nil : String(joined.prefix(2000)))
                }
                request.recognitionLevel = .accurate
                request.recognitionLanguages = ["zh-Hans", "en-US"]
                let handler = VNImageRequestHandler(cgImage: image.cg, options: [:])
                do { try handler.perform([request]) }
                catch { cont.resume(returning: nil) }
            }
        }
    }

    /// Immutable CGImage wrapper to carry the snapshot across the concurrency boundary safely.
    private struct SendableImage: @unchecked Sendable { let cg: CGImage }
}
