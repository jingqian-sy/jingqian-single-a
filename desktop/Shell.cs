using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace JingqianShell
{
    // DPI 缩放：界面按 96dpi 设计，屏幕 125%/150% 时按比例放大，别把窗口撑出屏幕
    static class Dpi
    {
        public static float S = 1f;
        public static int X(int v) { return (int)Math.Round(v * S); }
        public static void Init()
        {
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) S = Math.Max(1f, g.DpiX / 96f); }
            catch { S = 1f; }
        }
    }

    // ===================== 主题 =====================
    static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(244, 248, 251);
        public static readonly Color Paper = Color.White;
        public static readonly Color Accent = Color.FromArgb(90, 160, 210);
        public static readonly Color AccentDeep = Color.FromArgb(64, 124, 168);
        public static readonly Color UserBubble = Color.FromArgb(220, 238, 252);
        public static readonly Color AiBubble = Color.FromArgb(255, 255, 255);
        public static readonly Color Border = Color.FromArgb(226, 236, 244);
        public static readonly Color Text = Color.FromArgb(40, 54, 66);
        public static readonly Color Dim = Color.FromArgb(128, 146, 160);
        public static readonly Color Warn = Color.FromArgb(196, 104, 84);
        public static readonly Color OkDot = Color.FromArgb(92, 176, 140);

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = Math.Max(1, radius * 2);
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static Font Ui(float size, bool bold)
        {
            return new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
        }
    }

    // ===================== 配置读写（走 /api/config 中控台） =====================
    class ApiClient
    {
        public string BaseUrl;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();

        public ApiClient(string baseUrl)
        {
            BaseUrl = (baseUrl ?? "http://127.0.0.1:7889").TrimEnd('/');
        }

        public Dictionary<string, object> Get(string path, int timeoutMs)
        {
            return Request("GET", path, null, timeoutMs);
        }

        public Dictionary<string, object> Post(string path, object body, int timeoutMs)
        {
            return Request("POST", path, body, timeoutMs);
        }

        Dictionary<string, object> Request(string method, string path, object body, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            req.KeepAlive = false;
            if (body != null)
            {
                byte[] buf = Encoding.UTF8.GetBytes(json.Serialize(body));
                req.ContentType = "application/json; charset=utf-8";
                req.ContentLength = buf.Length;
                using (Stream s = req.GetRequestStream()) s.Write(buf, 0, buf.Length);
            }
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string txt = sr.ReadToEnd();
                    object o = json.DeserializeObject(txt);
                    Dictionary<string, object> d = o as Dictionary<string, object>;
                    if (d == null) throw new Exception("返回不是对象");
                    return d;
                }
            }
            catch (WebException we)
            {
                string msg = we.Message;
                try
                {
                    if (we.Response != null)
                    {
                        using (StreamReader sr = new StreamReader(we.Response.GetResponseStream(), Encoding.UTF8))
                        {
                            string t = sr.ReadToEnd();
                            Dictionary<string, object> d = json.DeserializeObject(t) as Dictionary<string, object>;
                            if (d != null && d.ContainsKey("error")) msg = Convert.ToString(d["error"]);
                        }
                    }
                }
                catch { }
                throw new Exception(msg);
            }
        }

        public bool Ping()
        {
            try
            {
                Dictionary<string, object> d = Get("/api/selfcheck", 1500);
                return d.ContainsKey("at");
            }
            catch { return false; }
        }

        public string Chat(string message, out string stats, out List<Dictionary<string, object>> trace)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["message"] = message;
            body["session"] = "web";
            Dictionary<string, object> r = Post("/api/chat", body, 180000);
            stats = "";
            trace = new List<Dictionary<string, object>>();
            if (r.ContainsKey("ok") && !Convert.ToBoolean(r["ok"]))
            {
                throw new Exception(r.ContainsKey("error") ? Convert.ToString(r["error"]) : "服务返回失败");
            }
            if (r.ContainsKey("stats") && r["stats"] is Dictionary<string, object>)
            {
                Dictionary<string, object> st = (Dictionary<string, object>)r["stats"];
                stats = (st.ContainsKey("total_tokens") ? Convert.ToString(st["total_tokens"]) : "0") + " tokens";
            }
            object tr;
            if (r.TryGetValue("trace", out tr) && tr is object[])
                foreach (object o in (object[])tr) { Dictionary<string, object> d = o as Dictionary<string, object>; if (d != null) trace.Add(d); }
            return r.ContainsKey("reply") ? Convert.ToString(r["reply"]) : "（空回复）";
        }

        public List<Dictionary<string, object>> History(string session)
        {
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            try
            {
                Dictionary<string, object> r = Get("/api/history?session=" + Uri.EscapeDataString(session) + "&limit=40", 3000);
                object items;
                if (r.TryGetValue("items", out items) && items is object[])
                {
                    foreach (object it in (object[])items)
                    {
                        Dictionary<string, object> d = it as Dictionary<string, object>;
                        if (d != null) list.Add(d);
                    }
                }
            }
            catch { }
            return list;
        }

        public Dictionary<string, object> GetConfig(int timeoutMs)
        {
            return Get("/api/config", timeoutMs);
        }

        public Dictionary<string, object> Stats()
        {
            return Get("/api/stats", 4000);
        }

        public bool SaveConfig(Dictionary<string, object> cfg)
        {
            Dictionary<string, object> r = Post("/api/config", cfg, 8000);
            return r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]);
        }
    }

    // ===================== 服务看护：探测 + 找不到就自己拉起来 =====================
    class ServiceKeeper
    {
        public string BaseUrl;
        public string RepoRoot;
        public Process Started;
        public string LastNote = "";

        public ServiceKeeper(string baseUrl, string repoRoot)
        {
            BaseUrl = baseUrl;
            RepoRoot = repoRoot;
        }

        public bool WaitUp(int timeoutMs)
        {
            ApiClient api = new ApiClient(BaseUrl);
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (api.Ping()) return true;
                Thread.Sleep(400);
            }
            return false;
        }

        public bool Ensure(int timeoutMs)
        {
            if (WaitUp(1200)) { LastNote = "服务已在跑"; return true; }
            string node = FindNode();
            if (node == null) { LastNote = "没找到 node"; return false; }
            string server = Path.Combine(RepoRoot, "src", "server.js");
            if (!File.Exists(server)) { LastNote = "找不到 src\\server.js（仓库根：" + RepoRoot + "）"; return false; }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = node;
                psi.Arguments = "\"" + server + "\"";
                psi.WorkingDirectory = RepoRoot;
                // 关键：不要把子进程的 stdout/stderr 接到本程序上。
                // 桌面壳退出后管道会断，node 再往断掉的 stdout 写就会 EPIPE 直接挂掉，
                // 于是「关掉软件服务也没了」。用 ShellExecute + 隐藏窗口，让服务独立活着。
                psi.UseShellExecute = true;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Started = Process.Start(psi);
                LastNote = "已用 " + node + " 启动服务（pid " + Started.Id + "），等它就绪…";
                bool up = WaitUp(timeoutMs);
                if (!up) LastNote += " 但等了 " + (timeoutMs / 1000) + " 秒还没起来";
                return up;
            }
            catch (Exception ex)
            {
                LastNote = "启动服务失败：" + ex.Message;
                return false;
            }
        }

        public static string FindNode()
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathVar.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch { }
            }
            string runtime = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Jingqian", "runtime");
            if (Directory.Exists(runtime))
            {
                try
                {
                    string[] hits = Directory.GetFiles(runtime, "node.exe", SearchOption.AllDirectories);
                    if (hits.Length > 0) return hits[0];
                }
                catch { }
            }
            return null;
        }
    }

    // ===================== 消息列表（自绘气泡） =====================
    class ChatView : ScrollableControl
    {
        // Kind: user / ai / note（工具调用小字）/ pending（正在想）
        class Msg { public bool User; public string Text; public string Time; public string Kind; }
        readonly List<Msg> msgs = new List<Msg>();
        readonly Font font = Theme.Ui(10f, false);
        readonly Font meta = Theme.Ui(8f, false);
        readonly Font noteFont = Theme.Ui(8f, false);
        int contentHeight = 0;

        public ChatView()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            AutoScroll = true;
            BackColor = Theme.Bg;
            Padding = new Padding(0);
        }

        public void Add(bool user, string text)
        {
            Msg m = new Msg();
            m.User = user;
            m.Kind = user ? "user" : "ai";
            m.Text = text ?? "";
            m.Time = DateTime.Now.ToString("HH:mm");
            msgs.Add(m);
            Reflow();
            Invalidate();
            ScrollToEnd();
        }

        public void AddNote(string text)
        {
            Msg m = new Msg();
            m.Kind = "note";
            m.Text = "· " + (text ?? "");
            m.Time = "";
            msgs.Add(m);
            Reflow();
            Invalidate();
            ScrollToEnd();
        }

        public int AddPending()
        {
            Msg m = new Msg();
            m.Kind = "pending";
            m.Text = "正在想…";
            m.Time = DateTime.Now.ToString("HH:mm:ss");
            msgs.Add(m);
            Reflow();
            Invalidate();
            ScrollToEnd();
            return msgs.Count - 1;
        }

        public void RemovePending(int index)
        {
            if (index >= 0 && index < msgs.Count && msgs[index].Kind == "pending") msgs.RemoveAt(index);
            Reflow();
            Invalidate();
        }

        public void Clear() { msgs.Clear(); Reflow(); Invalidate(); }

        void ScrollToEnd()
        {
            int h = Math.Max(0, contentHeight - ClientSize.Height + 16);
            // 让顶部不要出现「半截气泡」：把滚动位置对齐到某个气泡的上沿
            for (int i = 0; i < tops.Count; i++)
            {
                int t = tops[i][0], hh = tops[i][1];
                if (h > t && h < t + hh) { h = Math.Max(0, t - Dpi.X(6)); break; }
            }
            AutoScrollPosition = new Point(0, h);
        }

        public void ScrollToEndPublic() { ScrollToEnd(); }
        public int Count { get { return msgs.Count; } }
        readonly List<int[]> tops = new List<int[]>();

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Reflow();
            Invalidate();
        }

        void Reflow()
        {
            int pad = Dpi.X(16), maxW = Math.Max(Dpi.X(160), ClientSize.Width - pad * 2 - Dpi.X(24));
            int y = Dpi.X(12);
            tops.Clear();
            foreach (Msg m in msgs)
            {
                int top = y;
                int h;
                if (m.Kind == "note") h = Dpi.X(38);
                else
                {
                    Size sz = TextRenderer.MeasureText(m.Text.Length == 0 ? " " : m.Text, font,
                        new Size(Math.Min(maxW - Dpi.X(26), Dpi.X(340)), int.MaxValue), TextFormatFlags.WordBreak);
                    h = sz.Height + Dpi.X(40);
                }
                tops.Add(new int[] { top, h });
                y += h;
            }
            contentHeight = y;
            AutoScrollMinSize = new Size(0, y + Dpi.X(10));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.Bg);
            int pad = Dpi.X(16);
            int maxW = Math.Max(Dpi.X(160), ClientSize.Width - pad * 2 - Dpi.X(24));
            // WinForms 的 AutoScrollPosition getter 返回负的滚动量（往下滚 = 负数），
            // 所以要「加上」它才是内容在视口里的 y；之前用减号会把内容画到视口外，表现为消息区空白。
            int y = Dpi.X(12) + AutoScrollPosition.Y;
            foreach (Msg m in msgs)
            {
                if (m.Kind == "note")
                {
                    TextRenderer.DrawText(g, m.Text, noteFont,
                        new Rectangle(pad + Dpi.X(6), y + Dpi.X(2), ClientSize.Width - pad * 2 - Dpi.X(12), Dpi.X(36)),
                        Theme.Dim, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                    y += Dpi.X(38);
                    continue;
                }
                bool user = m.Kind == "user";
                Size sz = TextRenderer.MeasureText(m.Text.Length == 0 ? " " : m.Text, font,
                    new Size(Math.Min(maxW - Dpi.X(26), Dpi.X(340)), int.MaxValue), TextFormatFlags.WordBreak);
                int bw = Math.Min(Math.Max(sz.Width + Dpi.X(26), Dpi.X(52)), maxW);
                int bh = sz.Height + Dpi.X(22);
                // 顶部不留半截气泡：被视口上沿切到的整条跳过（背景留白，不画残块）
                if (y < 0) { y += bh + Dpi.X(24); continue; }
                int x = user ? (ClientSize.Width - pad - bw) : (pad + Dpi.X(4));
                Rectangle rr = new Rectangle(x, y, bw, bh);
                using (GraphicsPath gp = Theme.Round(rr, Dpi.X(14)))
                {
                    using (SolidBrush fill = new SolidBrush(user ? Theme.UserBubble : Theme.AiBubble))
                        g.FillPath(fill, gp);
                    if (!user)
                        using (Pen p = new Pen(Theme.Border, 1f)) g.DrawPath(p, gp);
                }
                Rectangle tr = new Rectangle(x + Dpi.X(13), y + Dpi.X(11), bw - Dpi.X(26), bh - Dpi.X(22));
                TextRenderer.DrawText(g, m.Text, font, tr, m.Kind == "pending" ? Theme.Dim : Theme.Text,
                    TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                if (m.Kind != "pending")
                {
                    TextRenderer.DrawText(g, user ? "你" : "鲸倩", meta,
                        new Rectangle(x + (user ? bw - Dpi.X(34) : Dpi.X(2)), y + bh + Dpi.X(2), Dpi.X(60), Dpi.X(16)),
                        Theme.Dim, TextFormatFlags.NoPadding);
                }
                y += bh + Dpi.X(24);
            }
            if (msgs.Count == 0)
            {
                TextRenderer.DrawText(g, "在的。说点什么吧。", Theme.Ui(10f, false),
                    new Rectangle(pad + Dpi.X(8), Dpi.X(24), ClientSize.Width - pad * 2, Dpi.X(40)), Theme.Dim,
                    TextFormatFlags.NoPadding);
            }
        }
    }

    // ===================== 顶部标题栏（拖动 + 三个按钮） =====================
    class CaptionBar : Control
    {
        public string Title = "鲸倩";
        public string StatusText = "连接中…";
        public bool Online;
        public Image AppIcon;
        public event EventHandler MinClick;
        public event EventHandler MaxClick;
        public event EventHandler CloseClick;
        int hover = -1;
        readonly Font titleFont = Theme.Ui(11f, true);
        readonly Font statusFont = Theme.Ui(8.5f, false);

        public CaptionBar()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            Height = Dpi.X(48);
            BackColor = Theme.Paper;
        }

        Rectangle BtnRect(int i)
        {
            int w = Dpi.X(44);
            return new Rectangle(Width - (3 - i) * w, 0, w, Height);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int h = -1;
            for (int i = 0; i < 3; i++) if (BtnRect(i).Contains(e.Location)) h = i;
            if (h != hover) { hover = h; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hover = -1; Invalidate(); base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            for (int i = 0; i < 3; i++)
            {
                if (BtnRect(i).Contains(e.Location))
                {
                    if (i == 0 && MinClick != null) MinClick(this, EventArgs.Empty);
                    if (i == 1 && MaxClick != null) MaxClick(this, EventArgs.Empty);
                    if (i == 2 && CloseClick != null) CloseClick(this, EventArgs.Empty);
                    return;
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Paper);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            if (AppIcon != null) g.DrawImage(AppIcon, new Rectangle(Dpi.X(14), (Height - Dpi.X(20)) / 2, Dpi.X(20), Dpi.X(20)));
            TextRenderer.DrawText(g, Title, titleFont, new Rectangle(Dpi.X(42), Dpi.X(8), Dpi.X(120), Dpi.X(26)), Theme.Text, TextFormatFlags.NoPadding);
            using (SolidBrush dot = new SolidBrush(Online ? Theme.OkDot : Theme.Warn))
                g.FillEllipse(dot, Dpi.X(108), Dpi.X(22), Dpi.X(7), Dpi.X(7));
            TextRenderer.DrawText(g, StatusText, statusFont, new Rectangle(Dpi.X(120), Dpi.X(17), Width - Dpi.X(300), Dpi.X(20)), Theme.Dim,
                TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
            for (int i = 0; i < 3; i++)
            {
                Rectangle r = BtnRect(i);
                if (hover == i) using (SolidBrush b = new SolidBrush(i == 2 ? Color.FromArgb(250, 226, 226) : Color.FromArgb(238, 246, 252)))
                    g.FillRectangle(b, r);
                Color ink = i == 2 && hover == i ? Theme.Warn : Theme.Dim;
                using (Pen p = new Pen(ink, 1.4f))
                {
                    int cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2;
                    int q = Dpi.X(5);
                    if (i == 0) g.DrawLine(p, cx - q, cy, cx + q, cy);
                    if (i == 1)
                    {
                        g.DrawRectangle(p, cx - q, cy - q, q * 2, q * 2);
                    }
                    if (i == 2)
                    {
                        g.DrawLine(p, cx - q, cy - q, cx + q, cy + q);
                        g.DrawLine(p, cx + q, cy - q, cx - q, cy + q);
                    }
                }
            }
            using (Pen p = new Pen(Theme.Border, 1f)) g.DrawLine(p, 0, Height - 1, Width, Height - 1);
        }
    }

    // ===================== 主窗口 =====================
    class MainForm : Form
    {
        readonly string repoRoot;
        ApiClient api;
        ServiceKeeper keeper;
        ChatView chatView;
        TextBox input;
        Button sendBtn;
        Panel inputWrap;
        Button settingsBtn;
        CaptionBar caption;
        NotifyIcon tray;
        Label statsLabel;
        Label clockLabel;
        ToolTip tip;
        int statTick;
        public bool VerifyOnly;
        public bool DumpBubbles;
        public string DumpShotPath;
        public int DumpCount;
        public string AutoSendText;
        System.Windows.Forms.Timer statusTimer;
        bool sending;

        public MainForm(string repoRoot, string baseUrl, bool openSettings)
        {
            this.repoRoot = repoRoot;
            api = new ApiClient(baseUrl);
            keeper = new ServiceKeeper(baseUrl, repoRoot);

            Text = "鲸倩";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(Dpi.X(900), Dpi.X(700));
            MinimumSize = new Size(Dpi.X(720), Dpi.X(520));
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            if (Height > wa.Height - Dpi.X(24)) Height = wa.Height - Dpi.X(24);
            if (Width > wa.Width - Dpi.X(24)) Width = wa.Width - Dpi.X(24);
            if (Environment.GetEnvironmentVariable("JQ_SHELL_OFFSCREEN") == "1")
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-30000, -30000);
                ShowInTaskbar = false;
            }
            BackColor = Theme.Bg;
            DoubleBuffered = true;
            AutoScaleMode = AutoScaleMode.None;
            try
            {
                string ico = Path.Combine(Application.StartupPath, "icon.ico");
                if (File.Exists(ico)) Icon = new Icon(ico, 32, 32);
            }
            catch { }

            BuildUi();
            BuildTray();

            Shown += delegate
            {
                ApplyRound();
                StartServiceAsync(delegate (bool ok)
                {
                    SetOnline(ok);
                    // 正常启动路径：服务起来后再拉历史（最多重试 3 次，1 秒一次），
                    // 拉到就把滚动条拉到底；这里同步做，避免异步回调抢在句柄/布局前面。
                    int bubbles = VerifyOnly ? 0 : LoadHistoryWithRetry(0);
                    if (DumpBubbles)
                    {
                        DumpCount = bubbles;
                        try { RefreshStats(); } catch { }
                        Console.WriteLine("bubbles=" + bubbles + " (session=web, 服务状态=" + (ok ? "up" : "down") + ")");
                        try
                        {
                            string p = string.IsNullOrEmpty(DumpShotPath) ? null : DumpShotPath;
                            if (p != null)
                            {
                                using (Bitmap bmp = new Bitmap(Width, Height))
                                {
                                    using (Graphics g = Graphics.FromImage(bmp))
                                    {
                                        IntPtr hdc = g.GetHdc();
                                        bool cap = Native.PrintWindow(Handle, hdc, 0);
                                        g.ReleaseHdc(hdc);
                                        if (!cap) { hdc = g.GetHdc(); Native.PrintWindow(Handle, hdc, 0); g.ReleaseHdc(hdc); }
                                    }
                                    bmp.Save(p, System.Drawing.Imaging.ImageFormat.Png);
                                }
                                Console.WriteLine("shot " + p);
                            }
                        }
                        catch (Exception ex) { Console.WriteLine("shot fail " + ex.Message); }
                        Close();
                        return;
                    }
                    if (ok)
                    {
                        Activate();
                        if (input != null) { input.Select(); input.Focus(); }
                    }
                    if (openSettings) OpenSettings();
                    if (!string.IsNullOrEmpty(AutoSendText))
                    {
                        string t = AutoSendText;
                        AutoSendText = null;
                        if (ok) SendText(t);
                    }
                });
            };
            Resize += delegate
            {
                ApplyRound();
                if (inputWrap != null && sendBtn != null)
                {
                    int rightW = Dpi.X(78) * 2 + Dpi.X(8);   // 发送 + 设置 并排
                    int w = Math.Max(Dpi.X(200), Width - Dpi.X(28) - rightW - Dpi.X(10));
                    inputWrap.Width = w;
                    if (input != null) input.Width = Math.Max(Dpi.X(120), w - Dpi.X(24));
                    sendBtn.Left = inputWrap.Left + inputWrap.Width + Dpi.X(10);
                    if (settingsBtn != null) settingsBtn.Left = sendBtn.Left + sendBtn.Width + Dpi.X(8);
                    if (statsLabel != null) statsLabel.Width = Math.Max(Dpi.X(200), Width - Dpi.X(110));
                }
            };
            FormClosing += delegate
            {
                if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
            };

            statusTimer = new System.Windows.Forms.Timer();
            statusTimer.Interval = 1000;
            statusTimer.Tick += delegate
            {
                statTick++;
                if (clockLabel != null) clockLabel.Text = DateTime.Now.ToString("HH:mm:ss");
                if (statTick % 5 == 0)
                {
                    SetOnline(api.Ping());
                    RefreshStats();
                }
            };
            statusTimer.Start();
        }

        void BuildUi()
        {
            caption = new CaptionBar();
            caption.Dock = DockStyle.Top;
            caption.AppIcon = LoadSmallIcon();
            caption.MinClick += delegate { WindowState = FormWindowState.Minimized; };
            caption.MaxClick += delegate
            {
                WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            };
            caption.CloseClick += delegate { HideToTray(); };
            caption.MouseDown += DragWindow;
            Controls.Add(caption);

            // 顶部一排按钮（文字，不用 emoji：老板机器上 emoji 会变方块）
            Panel toolbar = new Panel();
            toolbar.Dock = DockStyle.Top;
            toolbar.Height = Dpi.X(38);
            toolbar.BackColor = Theme.Bg;
            toolbar.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f)) e.Graphics.DrawLine(p, 0, toolbar.Height - 1, toolbar.Width, toolbar.Height - 1);
            };
            int tx = Dpi.X(10);
            Button bNew = MakeButton("新对话", Color.White, Theme.AccentDeep);
            bNew.FlatAppearance.BorderColor = Theme.Border;
            bNew.FlatAppearance.BorderSize = 1;
            bNew.SetBounds(tx, Dpi.X(6), TextWidth("新对话"), Dpi.X(26));
            bNew.Click += delegate { chatView.Clear(); caption.StatusText = "已清空显示"; caption.Invalidate(); };
            toolbar.Controls.Add(bNew);
            tx += bNew.Width + Dpi.X(6);
            Button bState = MakeButton("状态", Color.White, Theme.AccentDeep);
            bState.FlatAppearance.BorderColor = Theme.Border;
            bState.FlatAppearance.BorderSize = 1;
            bState.SetBounds(tx, Dpi.X(6), TextWidth("状态"), Dpi.X(26));
            bState.Click += delegate { ShowStatus(); };
            toolbar.Controls.Add(bState);
            tx += bState.Width + Dpi.X(6);
            Button bMem = MakeButton("记忆", Color.White, Theme.AccentDeep);
            bMem.FlatAppearance.BorderColor = Theme.Border;
            bMem.FlatAppearance.BorderSize = 1;
            bMem.SetBounds(tx, Dpi.X(6), TextWidth("记忆"), Dpi.X(26));
            bMem.Click += delegate { OpenMemory(); };
            toolbar.Controls.Add(bMem);
            tx += bMem.Width + Dpi.X(6);
            Button bSet = MakeButton("设置", Theme.Accent, Color.White);
            bSet.SetBounds(tx, Dpi.X(6), TextWidth("设置"), Dpi.X(26));
            bSet.Click += delegate { OpenSettings(); };
            toolbar.Controls.Add(bSet);
            tx += bSet.Width + Dpi.X(6);
            Button bTray = MakeButton("托盘", Color.White, Theme.AccentDeep);
            bTray.FlatAppearance.BorderColor = Theme.Border;
            bTray.FlatAppearance.BorderSize = 1;
            bTray.SetBounds(tx, Dpi.X(6), TextWidth("托盘"), Dpi.X(26));
            bTray.Click += delegate { HideToTray(); };
            toolbar.Controls.Add(bTray);
            Controls.Add(toolbar);

            Panel bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = Dpi.X(132);
            bottom.BackColor = Theme.Paper;
            bottom.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f)) e.Graphics.DrawLine(p, 0, 0, bottom.Width, 0);
            };

            inputWrap = new Panel();
            Panel inputBox = inputWrap;
            inputBox.SetBounds(Dpi.X(14), Dpi.X(10), Dpi.X(300), Dpi.X(74));
            inputBox.BackColor = Theme.Bg;
            inputBox.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath gp = Theme.Round(new Rectangle(0, 0, inputBox.Width - 1, inputBox.Height - 1), Dpi.X(10)))
                {
                    using (SolidBrush b = new SolidBrush(Color.White)) e.Graphics.FillPath(b, gp);
                    using (Pen p = new Pen(Theme.Border, 1f)) e.Graphics.DrawPath(p, gp);
                }
            };

            input = new TextBox();
            input.Multiline = true;
            input.BorderStyle = BorderStyle.None;
            input.BackColor = Color.White;
            input.ForeColor = Theme.Text;
            input.Font = Theme.Ui(10f, false);
            input.ScrollBars = ScrollBars.Vertical;
            input.SetBounds(10, 9, 278, 54);
            input.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter && !e.Shift && !e.Control)
                {
                    e.SuppressKeyPress = true;
                    SendCurrent();
                }
            };
            inputBox.Controls.Add(input);
            bottom.Controls.Add(inputBox);

            sendBtn = MakeButton("发送", Theme.Accent, Color.White);
            sendBtn.SetBounds(Dpi.X(322), Dpi.X(10), Dpi.X(78), Dpi.X(40));
            sendBtn.Click += delegate { SendCurrent(); };
            bottom.Controls.Add(sendBtn);

            settingsBtn = MakeButton("设置", Color.FromArgb(228, 240, 250), Theme.AccentDeep);
            settingsBtn.SetBounds(Dpi.X(408), Dpi.X(10), Dpi.X(78), Dpi.X(40));
            settingsBtn.Click += delegate { OpenSettings(); };
            bottom.Controls.Add(settingsBtn);

            // 底部数据栏：tok/s · 缓存 · 上下文 · 今日调用 · 走哪家 · 时钟
            statsLabel = new Label();
            statsLabel.AutoSize = false;
            statsLabel.Text = "数据栏：连上服务后显示";
            statsLabel.ForeColor = Theme.Dim;
            statsLabel.Font = Theme.Ui(8f, false);
            statsLabel.SetBounds(Dpi.X(14), Dpi.X(102), Dpi.X(360), Dpi.X(20));
            bottom.Controls.Add(statsLabel);
            clockLabel = new Label();
            clockLabel.AutoSize = false;
            clockLabel.TextAlign = ContentAlignment.TopRight;
            clockLabel.ForeColor = Theme.Dim;
            clockLabel.Font = Theme.Ui(8f, false);
            clockLabel.SetBounds(bottom.Width - Dpi.X(80), Dpi.X(102), Dpi.X(64), Dpi.X(20));
            clockLabel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            bottom.Controls.Add(clockLabel);
            tip = new ToolTip();
            tip.SetToolTip(statsLabel, "鼠标停在这里看今天用量");
            Controls.Add(bottom);

            chatView = new ChatView();
            chatView.Dock = DockStyle.Fill;
            Controls.Add(chatView);
            chatView.BringToFront();

            // 右下角拖拽改大小
            Panel grip = new Panel();
            grip.Size = new Size(Dpi.X(16), Dpi.X(16));
            grip.BackColor = Color.Transparent;
            grip.Cursor = Cursors.SizeNWSE;
            Point dragStart = Point.Empty;
            bool dragging = false;
            grip.MouseDown += delegate (object s, MouseEventArgs e) { dragging = true; dragStart = e.Location; grip.Capture = true; };
            grip.MouseMove += delegate (object s, MouseEventArgs e)
            {
                if (!dragging) return;
                Size = new Size(Math.Max(MinimumSize.Width, Width + e.X - dragStart.X),
                    Math.Max(MinimumSize.Height, Height + e.Y - dragStart.Y));
            };
            grip.MouseUp += delegate { dragging = false; grip.Capture = false; };
            Controls.Add(grip);
            grip.BringToFront();
            Resize += delegate { grip.Location = new Point(Width - Dpi.X(18), Height - Dpi.X(18)); };
        }

        int TextWidth(string text)
        {
            return TextRenderer.MeasureText(text, Theme.Ui(9f, true)).Width + Dpi.X(22);
        }

        void ShowStatus()
        {
            string msg;
            try
            {
                Dictionary<string, object> sc = api.Get("/api/selfcheck", 3000);
                string providers = "—";
                object pv;
                if (sc.TryGetValue("providers", out pv) && pv is object[])
                {
                    List<string> names = new List<string>();
                    foreach (object o in (object[])pv)
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d != null && d.ContainsKey("name")) names.Add(Convert.ToString(d["name"]));
                    }
                    if (names.Count > 0) providers = string.Join("、", names.ToArray());
                }
                msg = "服务：" + api.BaseUrl + "\n模型：" + providers
                    + "\n记忆：" + (sc.ContainsKey("memory") ? "见 /api/stats" : "—")
                    + "\n窗口模式：软件版外壳（业务逻辑在 Node 服务里）";
            }
            catch (Exception ex) { msg = "服务连不上：" + ex.Message; }
            MessageBox.Show(this, msg, "状态 · 鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void RefreshStats()
        {
            try
            {
                Dictionary<string, object> st = api.Stats();
                string tps = "—", cache = "—", ctx = "—", calls = "—", provider = "—", todayTip = "";
                object lastObj;
                if (st.TryGetValue("last", out lastObj) && lastObj is Dictionary<string, object>)
                {
                    Dictionary<string, object> last = (Dictionary<string, object>)lastObj;
                    double tok = last.ContainsKey("tokens") ? Convert.ToDouble(last["tokens"]) : 0;
                    double ms = last.ContainsKey("ms") ? Convert.ToDouble(last["ms"]) : 0;
                    if (tok > 0 && ms > 0) tps = (tok * 1000.0 / ms).ToString("0.0");
                    if (last.ContainsKey("cache_rate") && last["cache_rate"] != null) cache = Convert.ToString(last["cache_rate"]) + "%";
                    if (last.ContainsKey("prompt_tokens")) ctx = Convert.ToString(last["prompt_tokens"]);
                    if (last.ContainsKey("provider") && Convert.ToString(last["provider"]).Length > 0) provider = Convert.ToString(last["provider"]);
                }
                object lt;
                if (st.TryGetValue("ledger_today", out lt) && lt is Dictionary<string, object>)
                {
                    Dictionary<string, object> d = (Dictionary<string, object>)lt;
                    if (d.ContainsKey("calls")) calls = Convert.ToString(d["calls"]);
                    string tk = d.ContainsKey("prompt_tokens") && d.ContainsKey("completion_tokens")
                        ? Convert.ToString(Convert.ToInt64(d["prompt_tokens"]) + Convert.ToInt64(d["completion_tokens"])) : "—";
                    string cost = d.ContainsKey("cost") ? Convert.ToString(d["cost"]) : "0";
                    todayTip = "今天：调用 " + calls + " 次 · " + tk + " tokens · 估算 ¥" + cost;
                }
                if (provider == "—")
                {
                    object pv;
                    if (st.TryGetValue("providers", out pv) && pv is object[])
                        foreach (object o in (object[])pv)
                        {
                            Dictionary<string, object> d = o as Dictionary<string, object>;
                            if (d != null && d.ContainsKey("name") && (!d.ContainsKey("ready") || Convert.ToBoolean(d["ready"])))
                            { provider = Convert.ToString(d["name"]); break; }
                        }
                }
                statsLabel.Text = "tok/s " + tps + "  ·  缓存 " + cache + "  ·  上下文 " + ctx
                    + "  ·  今日调用 " + calls + "  ·  " + provider;
                tip.SetToolTip(statsLabel, todayTip.Length > 0 ? todayTip : "今天还没有调用");
            }
            catch (Exception ex)
            {
                statsLabel.Text = "数据栏：服务没接上（" + ex.Message + "）";
            }
            clockLabel.Text = DateTime.Now.ToString("HH:mm:ss");
        }

        Button MakeButton(string text, Color back, Color fore)
        {
            Button b = new Button();
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = back;
            b.ForeColor = fore;
            b.Font = Theme.Ui(9.5f, true);
            b.Cursor = Cursors.Hand;
            return b;
        }

        void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                Native.ReleaseCapture();
                Native.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
            }
        }

        Image LoadSmallIcon()
        {
            try
            {
                string png = Path.Combine(Application.StartupPath, "icon.png");
                if (File.Exists(png)) return Image.FromFile(png);
            }
            catch { }
            try
            {
                string ico = Path.Combine(Application.StartupPath, "icon.ico");
                if (File.Exists(ico)) return new Icon(ico, 20, 20).ToBitmap();
            }
            catch { }
            return null;
        }

        void ApplyRound()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                Region = null;
                return;
            }
            // Win11：优先让系统画圆角（DwmSetWindowAttribute 33 = DWMWA_WINDOW_CORNER_PREFERENCE，2 = ROUND）
            try
            {
                int pref = 2;
                int hr = Native.DwmSetWindowAttribute(Handle, 33, ref pref, 4);
                if (hr == 0) { Region = null; return; }
            }
            catch { }
            // 老系统退回自己裁圆角
            using (GraphicsPath gp = Theme.Round(new Rectangle(0, 0, Width, Height), Dpi.X(16)))
            {
                Region = new Region(gp);
            }
        }

        void BuildTray()
        {
            tray = new NotifyIcon();
            try
            {
                string ico = Path.Combine(Application.StartupPath, "icon.ico");
                tray.Icon = File.Exists(ico) ? new Icon(ico) : SystemIcons.Application;
            }
            catch { tray.Icon = SystemIcons.Application; }
            tray.Text = "鲸倩";
            tray.Visible = true;
            tray.DoubleClick += delegate { RestoreFromTray(); };
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("显示鲸倩", null, delegate { RestoreFromTray(); });
            menu.Items.Add("设置", null, delegate { RestoreFromTray(); OpenSettings(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { Quit(); });
            tray.ContextMenuStrip = menu;
        }

        void HideToTray() { Hide(); }
        void RestoreFromTray() { Show(); WindowState = FormWindowState.Normal; Activate(); }
        void Quit() { if (tray != null) tray.Visible = false; Application.Exit(); }

        public void SetOnline(bool ok)
        {
            caption.Online = ok;
            caption.StatusText = ok ? "在" : "不在（服务没起来）";
            caption.Invalidate();
            if (sendBtn != null) sendBtn.Enabled = ok && !sending;
        }

        void StartServiceAsync(Action<bool> done)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool ok = keeper.Ensure(25000);
                try { BeginInvoke((MethodInvoker)delegate { done(ok); }); } catch { }
            });
        }

        // 同步把历史铺进气泡（返回铺了几条）；先 web（网页/软件版共用这个 session），
        // 没有再看 desktop（老版本软件版留下的），保证「服务里有对话，窗口就能看见」。
        public int LoadHistoryNow()
        {
            if (chatView != null && chatView.Count > 0) return chatView.Count;  // 已经铺过就别重复铺
            int n = 0;
            List<Dictionary<string, object>> items = api.History("web");
            if (items.Count == 0) items = api.History("desktop");
            foreach (Dictionary<string, object> it in items)
            {
                string role = it.ContainsKey("role") ? Convert.ToString(it["role"]) : "";
                // 兼容两种字段：服务端 items 用 content；有些桥接/旧数据用 text
                string content = it.ContainsKey("content") ? Convert.ToString(it["content"])
                    : (it.ContainsKey("text") ? Convert.ToString(it["text"]) : "");
                if (content.Trim().Length == 0) continue;
                chatView.Add(role == "user", content);
                n++;
            }
            if (n > 0) chatView.ScrollToEndPublic();
            return n;
        }

        // 服务可能刚起，接口还没就绪：最多重试 3 次、间隔 1 秒
        public int LoadHistoryWithRetry(int initialDelayMs)
        {
            if (initialDelayMs > 0) Thread.Sleep(initialDelayMs);
            for (int i = 0; i < 3; i++)
            {
                int n = LoadHistoryNow();
                if (n > 0) return n;
                Thread.Sleep(1000);
            }
            return 0;
        }

        void LoadHistory()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                List<Dictionary<string, object>> items = api.History("web");
                if (items.Count == 0) items = api.History("desktop");
                if (items.Count == 0) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        foreach (Dictionary<string, object> it in items)
                        {
                            string role = it.ContainsKey("role") ? Convert.ToString(it["role"]) : "";
                            string content = it.ContainsKey("content") ? Convert.ToString(it["content"]) : "";
                            if (content.Trim().Length == 0) continue;
                            chatView.Add(role == "user", content);
                        }
                        chatView.ScrollToEndPublic();
                    });
                }
                catch { }
            });
        }

        public void SendText(string text)
        {
            input.Text = text;
            SendCurrent();
        }

        void SendCurrent()
        {
            if (sending) return;
            string text = input.Text.Trim();
            if (text.Length == 0) return;
            input.Text = "";
            chatView.Add(true, text);
            sending = true;
            sendBtn.Enabled = false;
            sendBtn.Text = "…";
            caption.StatusText = "正在想（多步任务会慢一点）…";
            caption.Invalidate();
            int pending = chatView.AddPending();
            ThreadPool.QueueUserWorkItem(delegate
            {
                string reply, stats;
                List<Dictionary<string, object>> trace;
                try
                {
                    reply = api.Chat(text, out stats, out trace);
                }
                catch (Exception ex)
                {
                    reply = "（服务没接上：" + ex.Message + "）";
                    stats = "";
                    trace = new List<Dictionary<string, object>>();
                }
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        chatView.RemovePending(pending);
                        foreach (Dictionary<string, object> t in trace)
                        {
                            string name = t.ContainsKey("tool") ? Convert.ToString(t["tool"]) : "?";
                            string args = t.ContainsKey("args") ? Convert.ToString(t["args"]) : "";
                            string result = t.ContainsKey("result") ? Convert.ToString(t["result"]) : "";
                            chatView.AddNote("工具 " + name + " · 结果：" + result);
                        }
                        chatView.Add(false, reply);
                        sending = false;
                        sendBtn.Text = "发送";
                        sendBtn.Enabled = true;
                        caption.StatusText = stats.Length > 0 ? ("在 · 上一条 " + stats) : "在";
                        caption.Invalidate();
                        RefreshStats();
                        if (input != null) { input.Select(); input.Focus(); }
                    });
                }
                catch { }
            });
        }

        public string LastToolLog = "";
        public void VerifyToolTask(string prompt)
        {
            chatView.Clear();
            chatView.Add(true, prompt);
            string reply, stats;
            List<Dictionary<string, object>> trace;
            try { reply = api.Chat(prompt, out stats, out trace); }
            catch (Exception ex) { reply = "（失败：" + ex.Message + "）"; stats = ""; trace = new List<Dictionary<string, object>>(); }
            List<string> lines = new List<string>();
            foreach (Dictionary<string, object> t in trace)
            {
                string line = "工具 " + Convert.ToString(t["tool"]) + " · 结果：" + Convert.ToString(t["result"]);
                lines.Add(line);
                chatView.AddNote(line);
            }
            LastToolLog = trace.Count + " 个工具调用 :: " + string.Join(" | ", lines.ToArray());
            chatView.Add(false, reply);
            caption.StatusText = "在 · " + stats;
            caption.Invalidate();
            RefreshStats();
            Application.DoEvents();
            Thread.Sleep(400);
            Application.DoEvents();
        }

        public void OpenSettings()
        {
            try
            {
                using (SettingsForm f = new SettingsForm(api, repoRoot))
                {
                    f.ShowDialog(this);
                }
                SetOnline(api.Ping());
                if (input != null) { input.Select(); input.Focus(); }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "打开设置失败：" + ex.Message, "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        public void OpenMemory()
        {
            try
            {
                using (MemoryForm f = new MemoryForm(api))
                {
                    f.ShowDialog(this);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "打开记忆失败：" + ex.Message, "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }

    // ===================== 设置窗 =====================
    class SettingsForm : Form
    {
        readonly ApiClient api;
        readonly string repoRoot;
        TextBox txtUrl, txtPort, txtBase, txtModel, txtKey;
        ComboBox cmbTier, cmbSandbox;
        TextBox txtWhitelist, txtQQUrl, txtQQToken;
        CheckBox chkMemory, chkQQAdvanced;
        Button btnQQFind, btnQQLink, btnQQUnlink;
        Label lblQQStatus;
        bool qqConnected;
        string qqGateway, qqToken;
        string qqNickname;
        ListView list;
        List<Dictionary<string, object>> providers = new List<Dictionary<string, object>>();
        int current = -1;

        public SettingsForm(ApiClient api, string repoRoot)
        {
            this.api = api;
            this.repoRoot = repoRoot;
            Text = "设置 · 鲸倩";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(640, 780);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            BackColor = Theme.Bg;
            Font = Theme.Ui(9.5f, false);
            try
            {
                string ico = Path.Combine(Application.StartupPath, "icon.ico");
                if (File.Exists(ico)) Icon = new Icon(ico, 32, 32);
            }
            catch { }
            BuildUi();
            LoadConfig();
        }

        void BuildUi()
        {
            Label t1 = Cap("服务地址", 16, 16);
            txtUrl = Box(16, 38, 380);
            txtUrl.AccessibleName = "cfgUrl";
            Label t2 = Cap("端口", 412, 16);
            txtPort = Box(412, 38, 80);
            txtPort.AccessibleName = "cfgPort";

            Label t3 = Cap("模型提供方（读 /api/config）", 16, 78);
            list = new ListView();
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HideSelection = false;
            list.SetBounds(16, 100, 608, 150);
            list.Columns.Add("名字", 120);
            list.Columns.Add("档位", 70);
            list.Columns.Add("模型", 150);
            list.Columns.Add("base", 262);
            list.AccessibleName = "cfgProviders";
            list.SelectedIndexChanged += delegate
            {
                if (list.SelectedIndices.Count > 0) SelectProvider(list.SelectedIndices[0]);
            };
            Controls.Add(list);

            Label t4 = Cap("选中提供方", 16, 262);
            Label b1 = Cap("base", 16, 286);
            txtBase = Box(16, 306, 608);
            txtBase.AccessibleName = "cfgBase";
            Label b2 = Cap("模型", 16, 342);
            txtModel = Box(16, 362, 300);
            txtModel.AccessibleName = "cfgModel";
            Label b3 = Cap("密钥", 336, 342);
            txtKey = Box(336, 362, 288);
            txtKey.PasswordChar = '*';
            txtKey.AccessibleName = "cfgKey";
            Label b4 = Cap("档位", 16, 398);
            cmbTier = new ComboBox();
            cmbTier.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbTier.SetBounds(16, 418, 140, 26);
            cmbTier.Items.Add("local");
            cmbTier.Items.Add("cloud");
            cmbTier.AccessibleName = "cfgTier";
            Controls.Add(cmbTier);

            Label b5 = Cap("沙盒档位", 180, 398);
            cmbSandbox = new ComboBox();
            cmbSandbox.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbSandbox.SetBounds(180, 418, 130, 26);
            cmbSandbox.Items.Add("none");
            cmbSandbox.Items.Add("process");
            cmbSandbox.Items.Add("docker");
            cmbSandbox.AccessibleName = "cfgSandbox";
            Controls.Add(cmbSandbox);

            Label b6 = Cap("命令白名单（逗号分隔）", 16, 450);
            txtWhitelist = Box(16, 470, 608);
            txtWhitelist.AccessibleName = "cfgWhitelist";

            chkMemory = new CheckBox();
            chkMemory.Text = "自动记记忆（autoCapture）";
            chkMemory.SetBounds(16, 502, 300, 24);
            chkMemory.AccessibleName = "cfgMemory";
            Controls.Add(chkMemory);

            Label q1 = Cap("QQ 一键连接（可选，默认关；聊天/记忆/工具都在本机）", 16, 528);
            btnQQFind = new Button();
            btnQQFind.Text = "自动找 QQ 桥接";
            btnQQFind.SetBounds(16, 550, 150, 34);
            btnQQFind.BackColor = Theme.Accent;
            btnQQFind.ForeColor = Color.White;
            btnQQFind.FlatStyle = FlatStyle.Flat;
            btnQQFind.FlatAppearance.BorderSize = 0;
            btnQQFind.AccessibleName = "cfgQQFind";
            btnQQFind.Click += delegate { QQFind(); };
            Controls.Add(btnQQFind);

            lblQQStatus = new Label();
            lblQQStatus.AutoSize = false;
            lblQQStatus.Text = "QQ：未检测";
            lblQQStatus.ForeColor = Theme.Dim;
            lblQQStatus.SetBounds(176, 556, 300, 24);
            Controls.Add(lblQQStatus);

            btnQQLink = new Button();
            btnQQLink.Text = "连接";
            btnQQLink.SetBounds(486, 550, 70, 34);
            btnQQLink.FlatStyle = FlatStyle.Flat;
            btnQQLink.Enabled = false;
            btnQQLink.AccessibleName = "cfgQQLink";
            btnQQLink.Click += delegate { QQConnect(); };
            Controls.Add(btnQQLink);

            btnQQUnlink = new Button();
            btnQQUnlink.Text = "断开";
            btnQQUnlink.SetBounds(564, 550, 70, 34);
            btnQQUnlink.FlatStyle = FlatStyle.Flat;
            btnQQUnlink.Enabled = false;
            btnQQUnlink.AccessibleName = "cfgQQUnlink";
            btnQQUnlink.Click += delegate { QQDisconnect(); };
            Controls.Add(btnQQUnlink);

            chkQQAdvanced = new CheckBox();
            chkQQAdvanced.Text = "高级（显示网关地址 / 令牌）";
            chkQQAdvanced.SetBounds(16, 592, 300, 24);
            chkQQAdvanced.AccessibleName = "cfgQQAdvanced";
            chkQQAdvanced.CheckedChanged += delegate { ToggleQQAdvanced(); };
            Controls.Add(chkQQAdvanced);

            Label q2 = Cap("网关地址", 16, 620);
            txtQQUrl = Box(16, 640, 380);
            txtQQUrl.AccessibleName = "cfgQQUrl";
            Label q3 = Cap("令牌", 412, 620);
            txtQQToken = Box(412, 640, 212);
            txtQQToken.PasswordChar = '*';
            txtQQToken.AccessibleName = "cfgQQToken";
            txtQQUrl.Visible = false;
            txtQQToken.Visible = false;
            q2.Visible = false;
            q3.Visible = false;
            q2.Tag = "adv";
            q3.Tag = "adv";
            txtQQUrl.Tag = "adv";
            txtQQToken.Tag = "adv";
            Hint("没接网关时不用管它，不会报错；网桥收到消息后调本机 /api/chat，再把回复发回 QQ。", 16, 664);
            Hint("密钥显示为掩码；不改就沿用原来的。保存后需要重启服务才生效。", 16, 686);

            Button save = new Button();
            save.Text = "保存";
            save.SetBounds(436, 700, 90, 34);
            save.BackColor = Theme.Accent;
            save.ForeColor = Color.White;
            save.FlatStyle = FlatStyle.Flat;
            save.FlatAppearance.BorderSize = 0;
            save.AccessibleName = "btnSave";
            save.Click += delegate { Save(); };
            Controls.Add(save);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.SetBounds(536, 700, 88, 34);
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.AccessibleName = "btnCancel";
            cancel.Click += delegate { Close(); };
            Controls.Add(cancel);
        }

        Label Cap(string text, int x, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.ForeColor = Theme.Dim;
            l.Location = new Point(x, y - 2);
            Controls.Add(l);
            return l;
        }

        TextBox Box(int x, int y, int w)
        {
            TextBox b = new TextBox();
            b.SetBounds(x, y, w, 26);
            b.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(b);
            return b;
        }

        void Hint(string text, int x, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.ForeColor = Theme.Dim;
            l.Location = new Point(x, y);
            Controls.Add(l);
        }

        void LoadConfig()
        {
            try
            {
                Dictionary<string, object> r = api.GetConfig(5000);
                Dictionary<string, object> cfg = r.ContainsKey("config") ? (Dictionary<string, object>)r["config"] : r;
                txtUrl.Text = api.BaseUrl;
                txtPort.Text = cfg.ContainsKey("port") ? Convert.ToString(cfg["port"]) : "7889";
                providers = new List<Dictionary<string, object>>();
                object arr;
                if (cfg.TryGetValue("providers", out arr) && arr is object[])
                {
                    foreach (object o in (object[])arr)
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d != null) providers.Add(d);
                    }
                }
                RefreshList();
                if (providers.Count > 0) { list.Items[0].Selected = true; SelectProvider(0); }

                object sub;
                string sb = "none";
                if (cfg.TryGetValue("sandbox", out sub) && sub is Dictionary<string, object> && ((Dictionary<string, object>)sub).ContainsKey("mode"))
                    sb = Convert.ToString(((Dictionary<string, object>)sub)["mode"]);
                cmbSandbox.SelectedItem = (sb == "process" || sb == "docker") ? sb : "none";

                string wl = "";
                if (cfg.TryGetValue("tools", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> td = (Dictionary<string, object>)sub;
                    object w;
                    if (td.TryGetValue("commandWhitelist", out w) && w is object[])
                    {
                        List<string> xs = new List<string>();
                        foreach (object o in (object[])w) xs.Add(Convert.ToString(o));
                        wl = string.Join(",", xs.ToArray());
                    }
                }
                txtWhitelist.Text = wl;

                bool autoCap = true;
                if (cfg.TryGetValue("memory", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> md = (Dictionary<string, object>)sub;
                    if (md.ContainsKey("autoCapture")) autoCap = Convert.ToBoolean(md["autoCapture"]);
                }
                chkMemory.Checked = autoCap;

                qqConnected = false;
                qqGateway = "";
                qqToken = "";
                qqNickname = "";
                if (cfg.TryGetValue("qq", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> qd = (Dictionary<string, object>)sub;
                    qqConnected = qd.ContainsKey("enabled") && Convert.ToBoolean(qd["enabled"]);
                    qqGateway = qd.ContainsKey("gateway") ? Convert.ToString(qd["gateway"]) : "";
                    qqToken = qd.ContainsKey("token") ? Convert.ToString(qd["token"]) : "";
                }
                else if (cfg.TryGetValue("qqBridge", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> qd = (Dictionary<string, object>)sub;
                    qqConnected = qd.ContainsKey("enabled") && Convert.ToBoolean(qd["enabled"]);
                    qqGateway = qd.ContainsKey("url") ? Convert.ToString(qd["url"]) : "";
                    qqToken = qd.ContainsKey("token") ? Convert.ToString(qd["token"]) : "";
                }
                txtQQUrl.Text = qqGateway;
                txtQQToken.Text = qqToken;
                UpdateQQState();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "读配置失败：" + ex.Message + "\n\n请确认服务在跑（地址 " + api.BaseUrl + "）。",
                    "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void RefreshList()
        {
            list.Items.Clear();
            foreach (Dictionary<string, object> p in providers)
            {
                string[] row = new string[] {
                    Get(p, "name"), Get(p, "tier"), Get(p, "model"), Get(p, "base")
                };
                list.Items.Add(new ListViewItem(row));
            }
        }

        static string Get(Dictionary<string, object> d, string k)
        {
            return d.ContainsKey(k) ? Convert.ToString(d[k]) : "";
        }

        void SelectProvider(int i)
        {
            if (i < 0 || i >= providers.Count) return;
            current = i;
            Dictionary<string, object> p = providers[i];
            txtBase.Text = Get(p, "base");
            txtModel.Text = Get(p, "model");
            txtKey.Text = Get(p, "key");
            string tier = Get(p, "tier");
            cmbTier.SelectedItem = tier == "local" ? "local" : "cloud";
        }

        void UpdateQQState()
        {
            if (lblQQStatus == null) return;
            if (qqConnected)
            {
                lblQQStatus.Text = "QQ：已连接" + (qqNickname.Length > 0 ? "（" + qqNickname + "）" : "");
                lblQQStatus.ForeColor = Color.FromArgb(60, 150, 100);
                btnQQLink.Enabled = false;
                btnQQUnlink.Enabled = true;
            }
            else
            {
                lblQQStatus.Text = "QQ：未连接（默认关，点左边按钮自动找）";
                lblQQStatus.ForeColor = Theme.Dim;
                btnQQLink.Enabled = qqGateway.Length > 0;
                btnQQUnlink.Enabled = false;
            }
        }

        void ToggleQQAdvanced()
        {
            bool v = chkQQAdvanced.Checked;
            foreach (Control c in Controls)
                if ((c.Tag as string) == "adv") c.Visible = v;
        }

        void QQFind()
        {
            btnQQFind.Enabled = false;
            lblQQStatus.Text = "正在找本机 QQ 桥接…";
            lblQQStatus.ForeColor = Theme.Dim;
            Application.DoEvents();
            try
            {
                Dictionary<string, object> r = api.Get("/api/qq/discover", 15000);
                if (r.ContainsKey("found") && Convert.ToBoolean(r["found"]))
                {
                    qqGateway = Convert.ToString(r["gateway"]);
                    qqToken = r.ContainsKey("token") ? Convert.ToString(r["token"]) : "";
                    string oldNick = qqNickname;
                    qqNickname = Convert.ToString(r["nickname"]) + " " + (r.ContainsKey("selfId") ? Convert.ToString(r["selfId"]) : "");
                    lblQQStatus.Text = "找到了：" + Convert.ToString(r["nickname"]) + "（账号 " + (r.ContainsKey("selfId") ? Convert.ToString(r["selfId"]) : "?") + "），点「连接」";
                    lblQQStatus.ForeColor = Theme.Text;
                    btnQQLink.Enabled = true;
                }
                else
                {
                    object hints;
                    string h = "没找到 QQ 桥接";
                    if (r.TryGetValue("hints", out hints) && hints is object[] && ((object[])hints).Length > 0)
                        h = Convert.ToString(((object[])hints)[0]);
                    lblQQStatus.Text = h + "（装好点「自动找 QQ 桥接」再试）";
                    lblQQStatus.ForeColor = Theme.Warn;
                    btnQQLink.Enabled = false;
                }
            }
            catch (Exception ex)
            {
                lblQQStatus.Text = "检测失败：" + ex.Message;
                lblQQStatus.ForeColor = Theme.Warn;
            }
            finally { btnQQFind.Enabled = true; }
        }

        void QQConnect()
        {
            btnQQLink.Enabled = false;
            lblQQStatus.Text = "正在连接…";
            Application.DoEvents();
            try
            {
                Dictionary<string, object> body = new Dictionary<string, object>();
                if (qqGateway.Length > 0) body["gateway"] = qqGateway;
                if (qqToken.Length > 0 && qqToken.IndexOf("****") < 0) body["token"] = qqToken;
                Dictionary<string, object> r = api.Post("/api/qq/connect", body, 20000);
                if (r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]))
                {
                    qqConnected = true;
                    qqNickname = r.ContainsKey("nickname") ? Convert.ToString(r["nickname"]) : "";
                    if (r.ContainsKey("gateway")) qqGateway = Convert.ToString(r["gateway"]);
                    UpdateQQState();
                }
                else
                {
                    lblQQStatus.Text = "连接失败：" + Convert.ToString(r.ContainsKey("error") ? r["error"] : "未知原因");
                    lblQQStatus.ForeColor = Theme.Warn;
                    btnQQLink.Enabled = true;
                }
            }
            catch (Exception ex)
            {
                lblQQStatus.Text = "连接失败：" + ex.Message;
                lblQQStatus.ForeColor = Theme.Warn;
                btnQQLink.Enabled = true;
            }
        }

        void QQDisconnect()
        {
            try
            {
                api.Post("/api/qq/disconnect", new Dictionary<string, object>(), 8000);
                qqConnected = false;
                UpdateQQState();
            }
            catch (Exception ex)
            {
                lblQQStatus.Text = "断开失败：" + ex.Message;
                lblQQStatus.ForeColor = Theme.Warn;
            }
        }

        void Save()
        {
            try
            {
                if (current >= 0 && current < providers.Count)
                {
                    providers[current]["base"] = txtBase.Text.Trim();
                    providers[current]["model"] = txtModel.Text.Trim();
                    providers[current]["key"] = txtKey.Text;
                    providers[current]["tier"] = Convert.ToString(cmbTier.SelectedItem ?? "cloud");
                }
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["port"] = txtPort.Text.Trim();
                body["providers"] = providers;
                Dictionary<string, object> sb = new Dictionary<string, object>();
                sb["mode"] = Convert.ToString(cmbSandbox.SelectedItem ?? "none");
                body["sandbox"] = sb;
                Dictionary<string, object> tb = new Dictionary<string, object>();
                List<string> wl = new List<string>();
                foreach (string x in txtWhitelist.Text.Split(',')) { if (x.Trim().Length > 0) wl.Add(x.Trim()); }
                tb["commandWhitelist"] = wl;
                body["tools"] = tb;
                Dictionary<string, object> mb = new Dictionary<string, object>();
                mb["autoCapture"] = chkMemory.Checked;
                body["memory"] = mb;
                Dictionary<string, object> qb = new Dictionary<string, object>();
                qb["enabled"] = qqConnected;
                qb["gateway"] = (qqGateway.Length > 0 ? qqGateway : txtQQUrl.Text.Trim());
                qb["token"] = txtQQToken.Text.Length > 0 ? txtQQToken.Text : qqToken;
                qb["url"] = (qqGateway.Length > 0 ? qqGateway : txtQQUrl.Text.Trim());
                body["qq"] = qb;
                body["qqBridge"] = qb;
                bool ok = api.SaveConfig(body);
                if (!ok) throw new Exception("服务没确认保存成功");
                MessageBox.Show(this, "存好了。\n\n重启服务才生效（关掉窗口重开，或重新打开鲸倩会自动换新配置）。",
                    "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Information);
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "保存失败：" + ex.Message, "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // 给无界面自测用：和设置窗走同一条保存路径（GET → 改 model → POST）
        public static string SaveModelViaApi(ApiClient api, string model)
        {
            Dictionary<string, object> r = api.GetConfig(5000);
            Dictionary<string, object> cfg = r.ContainsKey("config") ? (Dictionary<string, object>)r["config"] : r;
            List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
            object arr;
            if (cfg.TryGetValue("providers", out arr) && arr is object[])
                foreach (object o in (object[])arr) { Dictionary<string, object> d = o as Dictionary<string, object>; if (d != null) list.Add(d); }
            if (list.Count == 0) throw new Exception("config.json 里没有 providers");
            list[0]["model"] = model;
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["providers"] = list;
            if (cfg.ContainsKey("port")) body["port"] = cfg["port"];
            api.SaveConfig(body);
            return Convert.ToString(list[0]["name"]);
        }
    }

    // ===================== 记忆面板（搜 / 看 / 删） =====================
    class MemoryForm : Form
    {
        readonly ApiClient api;
        TextBox search;
        ListView list;
        Label hint;
        List<string> ids = new List<string>();

        public MemoryForm(ApiClient api)
        {
            this.api = api;
            Text = "记忆 · 鲸倩";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(660, 520);
            BackColor = Theme.Bg;
            Font = Theme.Ui(9.5f, false);
            try { string ico = Path.Combine(Application.StartupPath, "icon.ico"); if (File.Exists(ico)) Icon = new Icon(ico); } catch { }

            search = new TextBox();
            search.SetBounds(16, 20, 420, 26);
            search.AccessibleName = "memSearch";
            Controls.Add(search);

            Button go = new Button();
            go.Text = "搜索";
            go.SetBounds(446, 18, 90, 28);
            go.FlatStyle = FlatStyle.Flat;
            go.AccessibleName = "memSearchBtn";
            go.Click += delegate { Reload(search.Text.Trim()); };
            Controls.Add(go);

            Button refresh = new Button();
            refresh.Text = "刷新";
            refresh.SetBounds(544, 18, 90, 28);
            refresh.FlatStyle = FlatStyle.Flat;
            refresh.Click += delegate { search.Text = ""; Reload(""); };
            Controls.Add(refresh);

            list = new ListView();
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HideSelection = false;
            list.SetBounds(16, 56, 618, 400);
            list.Columns.Add("内容", 430);
            list.Columns.Add("类型", 70);
            list.Columns.Add("时间", 110);
            list.AccessibleName = "memList";
            Controls.Add(list);

            Button del = new Button();
            del.Text = "删除选中";
            del.SetBounds(16, 468, 110, 32);
            del.FlatStyle = FlatStyle.Flat;
            del.AccessibleName = "memDelete";
            del.Click += delegate
            {
                if (list.SelectedIndices.Count == 0) { hint.Text = "先选一条"; return; }
                string id = ids[list.SelectedIndices[0]];
                try
                {
                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["id"] = id;
                    api.Post("/api/memory/archive", body, 5000);
                    hint.Text = "已删除（归档）";
                    Reload(search.Text.Trim());
                }
                catch (Exception ex) { hint.Text = "删除失败：" + ex.Message; }
            };
            Controls.Add(del);

            hint = new Label();
            hint.AutoSize = true;
            hint.ForeColor = Theme.Dim;
            hint.SetBounds(140, 476, 480, 20);
            Controls.Add(hint);

            Reload("");
        }

        void Reload(string query)
        {
            try
            {
                string path = "/api/memory" + (query.Length > 0 ? ("?query=" + Uri.EscapeDataString(query)) : "");
                Dictionary<string, object> r = api.Get(path, 5000);
                object items;
                list.Items.Clear();
                ids.Clear();
                if (r.TryGetValue("hits", out items) && items is object[])
                {
                    foreach (object o in (object[])items) AddRow((Dictionary<string, object>)o);
                    hint.Text = "搜索「" + query + "」命中 " + list.Items.Count + " 条";
                }
                else if (r.TryGetValue("items", out items) && items is object[])
                {
                    foreach (object o in (object[])items) AddRow((Dictionary<string, object>)o);
                    hint.Text = "共 " + list.Items.Count + " 条（最近 50）";
                }
                else hint.Text = "没有记忆";
            }
            catch (Exception ex)
            {
                hint.Text = "读记忆失败：" + ex.Message;
            }
        }

        void AddRow(Dictionary<string, object> d)
        {
            string text = d.ContainsKey("text") ? Convert.ToString(d["text"]) : "";
            string kind = d.ContainsKey("kind") ? Convert.ToString(d["kind"]) : "";
            string at = d.ContainsKey("created_at") ? Convert.ToString(d["created_at"]) : "";
            if (at.Length > 16) at = at.Substring(0, 16).Replace("T", " ");
            ids.Add(d.ContainsKey("id") ? Convert.ToString(d["id"]) : "");
            list.Items.Add(new ListViewItem(new string[] { text, kind, at }));
        }
    }

    // ===================== 系统 API =====================
    static class Native
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        public static extern bool AttachConsole(int pid);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    }

    // ===================== 入口 =====================
    static class Program
    {
        static string FindRepoRoot()
        {
            string dir = Application.StartupPath;
            for (int i = 0; i < 6 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "src", "server.js"))) return dir;
                DirectoryInfo parent = Directory.GetParent(dir);
                dir = parent == null ? null : parent.FullName;
            }
            return Application.StartupPath;
        }

        // 无界面自测：服务 / 窗口（离屏创建 + PrintWindow 抓图）/ 真发消息 / 设置保存真改 config.json
        // 不把窗口弹到用户眼前：窗口建在屏幕外、不进任务栏，抓完立刻关。
        static int RunVerify(string repo, string baseUrl)
        {
            int fail = 0;
            Console.WriteLine("== 鲸倩软件版自检 ==");

            ServiceKeeper k = new ServiceKeeper(baseUrl, repo);
            bool up = k.Ensure(25000);
            Console.WriteLine("SERVICE " + (up ? "OK" : "FAIL") + " :: " + k.LastNote);
            if (!up) fail++;

            try
            {
                using (MainForm f = new MainForm(repo, baseUrl, false))
                {
                    f.VerifyOnly = true;
                    f.StartPosition = FormStartPosition.Manual;
                    f.Location = new Point(-30000, -30000);
                    f.ShowInTaskbar = false;
                    f.Show();
                    Application.DoEvents();
                    Thread.Sleep(400);
                    Application.DoEvents();
                    bool shown = f.IsHandleCreated && f.Visible && f.Width > 0 && f.Height > 0;
                    Console.WriteLine("WINDOW " + (shown ? "OK" : "FAIL") + " handle=" + f.Handle
                        + " size=" + f.Width + "x" + f.Height + " (离屏，不打扰)");
                    if (!shown) fail++;
                    if (shown)
                    {
                        // 历史：服务里有对话就必须铺进窗口；没有历史才显示欢迎语
                        try
                        {
                            int expected = new ApiClient(baseUrl).History("web").Count
                                + new ApiClient(baseUrl).History("desktop").Count;
                            int loaded = f.LoadHistoryNow();
                            Console.WriteLine("HISTORY loaded=" + loaded + " serverHas=" + (expected > 0 ? "yes" : "no"));
                            if (expected > 0 && loaded == 0) { fail++; Console.WriteLine("HISTORY FAIL 服务有历史但窗口没铺出来"); }
                        }
                        catch (Exception ex) { Console.WriteLine("HISTORY FAIL " + ex.Message); fail++; }
                        string png = Path.Combine(repo, "desktop", "_verify-window.png");
                        try
                        {
                            using (Bitmap bmp = new Bitmap(f.Width, f.Height))
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    IntPtr hdc = g.GetHdc();
                                    bool ok = Native.PrintWindow(f.Handle, hdc, 0);
                                    g.ReleaseHdc(hdc);
                                    if (!ok)
                                    {
                                        hdc = g.GetHdc();
                                        Native.PrintWindow(f.Handle, hdc, 0);
                                        g.ReleaseHdc(hdc);
                                    }
                                }
                                bmp.Save(png, System.Drawing.Imaging.ImageFormat.Png);
                            }
                            Console.WriteLine("SHOT " + png);
                        }
                        catch (Exception ex) { Console.WriteLine("SHOT FAIL " + ex.Message); }

                        // 真跑一条用工具的任务，把「调用了什么工具 + 结果」画进窗口再截一张
                        try
                        {
                            // 先清掉旧的 out.txt，避免命中 P1「覆盖要确认」，保证演示能真写成功
                            try
                            {
                                string old = Path.Combine(repo, "data", "workspace", "out.txt");
                                if (File.Exists(old)) File.Delete(old);
                            }
                            catch { }
                            f.VerifyToolTask("在工作目录建一个 out.txt，里面写：hello 软件版");
                            string png2 = Path.Combine(repo, "desktop", "_verify-tools.png");
                            using (Bitmap bmp = new Bitmap(f.Width, f.Height))
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    IntPtr hdc = g.GetHdc();
                                    bool ok = Native.PrintWindow(f.Handle, hdc, 0);
                                    g.ReleaseHdc(hdc);
                                    if (!ok) { hdc = g.GetHdc(); Native.PrintWindow(f.Handle, hdc, 0); g.ReleaseHdc(hdc); }
                                }
                                bmp.Save(png2, System.Drawing.Imaging.ImageFormat.Png);
                            }
                            Console.WriteLine("TOOLCHAT OK " + f.LastToolLog);
                            Console.WriteLine("SHOT " + png2);
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine("TOOLCHAT FAIL " + ex.Message);
                            fail++;
                        }
                    }
                    f.Hide();
                    f.Close();
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("WINDOW FAIL " + ex.Message);
                fail++;
            }

            try
            {
                ApiClient api = new ApiClient(baseUrl);
                JavaScriptSerializer js = new JavaScriptSerializer();
                string cfgFile = Path.Combine(repo, "config.json");
                Dictionary<string, object> cfg = js.DeserializeObject(File.ReadAllText(cfgFile)) as Dictionary<string, object>;
                object arr;
                string before = "";
                if (cfg != null && cfg.TryGetValue("providers", out arr) && arr is object[])
                {
                    object[] ps = (object[])arr;
                    if (ps.Length > 0 && ps[0] is Dictionary<string, object>)
                        before = Convert.ToString(((Dictionary<string, object>)ps[0])["model"]);
                }
                string probe = "qwen3-8b-tool-verify";
                SettingsForm.SaveModelViaApi(api, probe);
                Dictionary<string, object> cfg2 = js.DeserializeObject(File.ReadAllText(cfgFile)) as Dictionary<string, object>;
                string after = "";
                if (cfg2 != null && cfg2.TryGetValue("providers", out arr) && arr is object[])
                    after = Convert.ToString(((Dictionary<string, object>)((object[])arr)[0])["model"]);
                Console.WriteLine("CONFIG before=" + before + " -> after=" + after + " (设置窗同一条保存路径)");
                if (after != probe) fail++;
                if (before.Length > 0) SettingsForm.SaveModelViaApi(api, before);
                Dictionary<string, object> cfg3 = js.DeserializeObject(File.ReadAllText(cfgFile)) as Dictionary<string, object>;
                string restored = "";
                if (cfg3 != null && cfg3.TryGetValue("providers", out arr) && arr is object[])
                    restored = Convert.ToString(((Dictionary<string, object>)((object[])arr)[0])["model"]);
                Console.WriteLine("CONFIG restored=" + restored + (restored == before ? " OK" : " FAIL"));
                if (restored != before) fail++;
            }
            catch (Exception ex)
            {
                Console.WriteLine("CONFIG FAIL " + ex.Message);
                fail++;
            }

            Console.WriteLine(fail == 0 ? "VERIFY PASS" : "VERIFY FAIL (" + fail + ")");
            return fail == 0 ? 0 : 1;
        }

        [STAThread]
        static int Main(string[] args)
        {
            try { Native.AttachConsole(-1); } catch { }
            try { Native.SetProcessDPIAware(); Dpi.Init(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string repo = FindRepoRoot();
            string baseUrl = "http://127.0.0.1:7889";
            string model = null;
            string sendText = null;
            string shotPath = null;
            bool settings = false;
            string mode = "ui";
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--smoke") mode = "smoke";
                else if (args[i] == "--ensure-service") mode = "ensure";
                else if (args[i] == "--verify") mode = "verify";
                else if (args[i] == "--dump-bubbles") mode = "dump";
                else if (args[i] == "--shot" && i + 1 < args.Length) shotPath = args[++i];
                else if (args[i] == "--settings") settings = true;
                else if (args[i] == "--url" && i + 1 < args.Length) baseUrl = args[++i];
                else if (args[i] == "--send" && i + 1 < args.Length) sendText = args[++i];
                else if (args[i] == "--set-model" && i + 1 < args.Length) { model = args[++i]; mode = "setmodel"; }
            }
            if (mode != "ui")
            {
                try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            }

            if (mode == "verify") return RunVerify(repo, baseUrl);

            if (mode == "ensure")
            {
                ServiceKeeper k = new ServiceKeeper(baseUrl, repo);
                bool ok = k.Ensure(25000);
                Console.WriteLine((ok ? "OK " : "FAIL ") + k.LastNote);
                return ok ? 0 : 1;
            }
            if (mode == "smoke")
            {
                ServiceKeeper k = new ServiceKeeper(baseUrl, repo);
                bool up = k.Ensure(25000);
                Console.WriteLine("SERVICE " + (up ? "UP" : "DOWN") + " :: " + k.LastNote);
                if (!up) return 1;
                ApiClient api = new ApiClient(baseUrl);
                string stats;
                List<Dictionary<string, object>> trace;
                string reply = api.Chat("你好，用一句话说说你是谁、能干什么。", out stats, out trace);
                Console.WriteLine("REPLY " + reply.Replace("\r", " ").Replace("\n", " "));
                Console.WriteLine("STATS " + stats);
                return 0;
            }
            if (mode == "setmodel")
            {
                ServiceKeeper k = new ServiceKeeper(baseUrl, repo);
                if (!k.Ensure(20000)) { Console.WriteLine("FAIL 服务没起来"); return 1; }
                ApiClient api = new ApiClient(baseUrl);
                string name = SettingsForm.SaveModelViaApi(api, model);
                Console.WriteLine("OK provider=" + name + " model=" + model);
                return 0;
            }

            using (MainForm f = new MainForm(repo, baseUrl, settings))
            {
                f.AutoSendText = sendText;
                if (mode == "dump")
                {
                    f.DumpBubbles = true;
                    f.DumpShotPath = shotPath;
                    f.StartPosition = FormStartPosition.Manual;
                    f.Location = new Point(-30000, -30000);
                    f.ShowInTaskbar = false;
                }
                Application.Run(f);
                if (mode == "dump") return f.DumpCount > 0 ? 0 : 2;
            }
            return 0;
        }
    }
}
