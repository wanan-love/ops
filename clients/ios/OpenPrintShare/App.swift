import SwiftUI
import WebKit

// MARK: - App

@main
struct OpenPrintShareApp: App {
    var body: some Scene {
        WindowGroup {
            ConsoleView()
        }
    }
}

// MARK: - 连接界面 + Web 控制台

/// OpenPrintShare iOS 客户端（局域网客户端角色）
/// 连接局域网内运行 OpenPrintShare Host 的设备 A，加载其 Web 控制台
/// （http://host:3001/，OPS/1.0 REST + WebSocket）。
/// 实际打印由 Host 已安装驱动的系统打印机完成——客户端无需安装厂商驱动。
struct ConsoleView: View {
    @AppStorage("ops.host") private var lastHost: String = ""
    @State private var connected: Bool = false

    var body: some View {
        NavigationStack {
            Group {
                if connected {
                    WebView(url: consoleURL)
                } else {
                    ConnectForm(
                        initial: lastHost,
                        onConnect: { host in
                            lastHost = host
                            connected = true
                        }
                    )
                }
            }
            .navigationTitle("OpenPrintShare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if connected {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("地址") { connected = false }
                    }
                }
            }
        }
    }

    private var consoleURL: URL {
        var host = lastHost
        if host.hasPrefix("http://") { host = String(host.dropFirst(7)) }
        if host.hasSuffix("/") { host = String(host.dropLast()) }
        return URL(string: "http://\(host.contains(":") ? host : "\(host):3001")") ?? URL(string: "http://localhost:3001")!
    }
}

struct ConnectForm: View {
    let initial: String
    let onConnect: (String) -> Void
    @State private var host: String = ""

    var body: some View {
        Form {
            Section {
                TextField("Host 地址（如 192.168.1.50）", text: $host)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(connect)
                Button("连接控制台", action: connect)
                    .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
            } footer: {
                Text("输入局域网内 OpenPrintShare Host 设备地址。\nHost 控制台运行于 3001 端口；打印任务由 Host 侧系统打印机执行。")
            }
        }
        .onAppear { if host.isEmpty { host = initial } }
    }

    private func connect() {
        let trimmed = host.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        onConnect(trimmed)
    }
}

// MARK: - WKWebView 包装

struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptEnabled = true
        // 文件上传（Web 控制台提交 PDF）与下载支持
        config.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// 仅允许局域网 http 目标，外链跳系统浏览器
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url,
                  url.scheme == "http" || url.scheme == "https" else {
                decisionHandler(.cancel)
                return
            }
            if isLanHost(url) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
            }
        }

        private func isLanHost(_ url: URL) -> Bool {
            guard let host = url.host else { return false }
            if host == "localhost" || host == "127.0.0.1" { return true }
            if host.hasSuffix(".local") { return true }
            let parts = host.split(separator: ".")
            if parts.count == 4, let first = Int(parts[0]), (0...255).contains(first) {
                return [10, 192, 172, 169].contains(first)
            }
            return false
        }
    }
}
