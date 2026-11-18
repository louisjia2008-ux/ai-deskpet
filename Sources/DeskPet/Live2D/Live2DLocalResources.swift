import Foundation
import WebKit

/// Only trusted bundle JS may execute. The models origin serves data extensions only.
final class Live2DLocalResources: NSObject, WKURLSchemeHandler {
    static var managedModelDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet/Characters/Live2D", isDirectory: true)
    }
    let runtimeRoot: URL
    let modelRoot: URL
    init(runtimeRoot: URL, modelRoot: URL) {
        self.runtimeRoot = runtimeRoot.resolvingSymlinksInPath()
        self.modelRoot = modelRoot.resolvingSymlinksInPath()
    }
    static func resolved(_ url: URL, within root: URL, runtime: Bool) -> URL? {
        guard url.scheme == "deskpet", url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil else { return nil }
        let path = url.path
        let allowed = runtime ? ["html","js","json","txt"] : ["json","moc3","png","jpg","jpeg","zip"]
        guard allowed.contains(url.pathExtension.lowercased()), !path.split(separator: "/").contains("..") else { return nil }
        let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let result = canonicalRoot.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).resolvingSymlinksInPath().standardizedFileURL
        guard result.path.hasPrefix(canonicalRoot.path + "/") else { return nil }
        return result
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, ["runtime","models"].contains(url.host ?? ""),
              let file = Self.resolved(url, within: url.host == "runtime" ? runtimeRoot : modelRoot, runtime: url.host == "runtime"),
              let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = attrs[.size] as? NSNumber, size.intValue <= 128 * 1024 * 1024,
              let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let types = ["html":"text/html","js":"application/javascript","json":"application/json","png":"image/png","jpg":"image/jpeg","jpeg":"image/jpeg"]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": types[file.pathExtension] ?? "application/octet-stream",
            "Access-Control-Allow-Origin": "deskpet://runtime",
            "X-Content-Type-Options": "nosniff"
        ])!
        urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) { }
}
