package io.github.wananlove.openprintshare

import android.annotation.SuppressLint
import android.content.SharedPreferences
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * OpenPrintShare Android 客户端
 *
 * 角色为「局域网客户端」：连接局域网内运行 OpenPrintShare Host 的设备 A，
 * 加载其 Web 控制台（http://host:3001/，OPS/1.0 REST + WebSocket 直连）。
 * 打印任务实际由 Host 已安装驱动的系统打印机完成——客户端无需安装厂商驱动。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var connectView: View
    private lateinit var webViewContainer: LinearLayout
    private lateinit var webView: WebView
    private lateinit var hostInput: EditText
    private lateinit var progressBar: ProgressBar
    private lateinit var statusText: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        title = getString(R.string.app_name)

        prefs = getSharedPreferences("ops", MODE_PRIVATE)
        connectView = findViewById(R.id.connectView)
        webViewContainer = findViewById(R.id.webViewContainer)
        webView = findViewById(R.id.webView)
        hostInput = findViewById(R.id.hostInput)
        progressBar = findViewById(R.id.progressBar)
        statusText = findViewById(R.id.statusText)
        val connectBtn = findViewById<Button>(R.id.connectBtn)

        // WebView 配置
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // 仅允许局域网/本地 http(s)；外链交给系统浏览器
                val host = url.host ?: return false
                return if (url.scheme == "http" || url.scheme == "https") {
                    isLanHost(host) && (url.port == 3001 || url.port == -1)
                } else {
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                progressBar.visibility = View.GONE
                statusText.text = url
            }
        }
        webView.webChromeClient = WebChromeClient()

        // 回车直接连接
        hostInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connect()
                true
            } else false
        }
        connectBtn.setOnClickListener { connect() }

        // 历史地址回填 + 自动重连上次 Host
        val last = prefs.getString("lastHost", null)
        if (last != null) {
            hostInput.setText(last)
            openConsole(last)
        }
    }

    private fun connect() {
        var input = hostInput.text.toString().trim()
        if (input.isEmpty()) {
            hostInput.error = getString(R.string.err_empty_host)
            return
        }
        // 兼容用户粘贴完整 URL / 带 http / 只有 host
        input = input.removePrefix("http://").removePrefix("https://").trimEnd('/')
        val target = if (input.contains(':')) input else "$input:3001"
        prefs.edit().putString("lastHost", target).apply()
        openConsole(target)
    }

    private fun openConsole(target: String) {
        connectView.visibility = View.GONE
        webViewContainer.visibility = View.VISIBLE
        progressBar.visibility = View.VISIBLE
        statusText.text = "http://$target/"
        webView.loadUrl("http://$target/")
    }

    private fun isLanHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1") return true
        if (host.endsWith(".local")) return true
        val parts = host.split('.')
        if (parts.size == 4 && parts.all { it.toIntOrNull() in 0..255 }) {
            val first = parts[0].toInt()
            return first == 10 || first == 192 || first == 172 || first == 169
        }
        return false
    }

    /** 返回键：WebView 有历史则后退，否则回到连接界面 */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webViewContainer.visibility == View.VISIBLE) {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    showConnectView()
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun showConnectView() {
        webViewContainer.visibility = View.GONE
        connectView.visibility = View.VISIBLE
        webView.stopLoading()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }
}
