using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Speech.Recognition;
using System.Speech.Synthesis;
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

    // ===================== 圆角按钮（统一主窗口和两个面板的观感） =====================
    class FlatBtn : Button
    {
        public Color NormalBack;
        public Color NormalFore;
        public Color NormalBorder = Color.Transparent;
        public int Radius = 8;
        bool hover, pressed;

        public FlatBtn(string text, Color back, Color fore)
        {
            Text = text;
            NormalBack = back;
            NormalFore = fore;
            BackColor = back;
            ForeColor = fore;
            Font = Theme.Ui(9.5f, true);
            Cursor = Cursors.Hand;
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        }

        static Color Shift(Color c, int delta)
        {
            return Color.FromArgb(c.A, Math.Max(0, Math.Min(255, c.R + delta)), Math.Max(0, Math.Min(255, c.G + delta)), Math.Max(0, Math.Min(255, c.B + delta)));
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
            Color back = Enabled ? (pressed ? Shift(NormalBack, -18) : (hover ? Shift(NormalBack, 10) : NormalBack)) : Color.FromArgb(236, 241, 246);
            Color fore = Enabled ? NormalFore : Theme.Dim;
            Color border = NormalBorder;
            if (hover && !pressed && border == Theme.Border) border = Shift(Theme.Border, -18);
            Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath gp = Theme.Round(r, Dpi.X(Radius)))
            {
                using (SolidBrush b = new SolidBrush(back)) g.FillPath(b, gp);
                if (border != Color.Transparent)
                    using (Pen p = new Pen(border, 1f)) g.DrawPath(p, gp);
            }
            TextRenderer.DrawText(g, Text, Font, new Rectangle(0, 0, Width, Height), fore,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        }
    }

    // 本机朗读（System.Speech）：不联网、不要 key；优先中文声音
    static class Speech
    {
        public static string ZhVoiceName()
        {
            try
            {
                using (SpeechSynthesizer s = new SpeechSynthesizer())
                {
                    string first = "";
                    foreach (InstalledVoice v in s.GetInstalledVoices())
                    {
                        if (!v.Enabled) continue;
                        if (first.Length == 0) first = v.VoiceInfo.Name;
                        if (v.VoiceInfo.Culture != null && v.VoiceInfo.Culture.Name.StartsWith("zh")) return v.VoiceInfo.Name;
                    }
                    return first;
                }
            }
            catch { return ""; }
        }

        public static SpeechSynthesizer Make(string name, int rate)
        {
            SpeechSynthesizer s = new SpeechSynthesizer();
            try
            {
                string use = name;
                if (string.IsNullOrEmpty(use)) use = ZhVoiceName();
                if (!string.IsNullOrEmpty(use)) s.SelectVoice(use);
            }
            catch { }
            try { s.Rate = Math.Max(-10, Math.Min(10, rate)); } catch { }
            return s;
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
            return Chat(message, null, out stats, out trace);
        }

        // 带附件（拖进输入栏的本地文件路径）；附件由服务端读，界面只传路径
        public string Chat(string message, List<string> attachments, out string stats, out List<Dictionary<string, object>> trace)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["message"] = message;
            body["session"] = "web";
            if (attachments != null && attachments.Count > 0) body["attachments"] = attachments;
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
        // Kind: user / ai / note（工具调用小条）/ pending（正在想）
        class Msg { public bool User; public string Text; public string Time; public string Kind; public string Files; }
        readonly List<Msg> msgs = new List<Msg>();
        readonly Font font = Theme.Ui(10f, false);
        readonly Font meta = Theme.Ui(8f, false);
        readonly Font noteFont = Theme.Ui(8.5f, false);
        readonly Font emptyTitle = Theme.Ui(15f, true);
        readonly Font emptyHint = Theme.Ui(9.5f, false);
        readonly Font emptyTiny = Theme.Ui(8.5f, false);
        public Image EmptyIcon;
        int contentHeight = 0;
        readonly List<int[]> tops = new List<int[]>();

        int Pad { get { return Dpi.X(18); } }
        int Radius { get { return Dpi.X(13); } }
        int LabelH { get { return Dpi.X(18); } }
        int Gap { get { return Dpi.X(16); } }
        int MaxBubble { get { return Math.Min(Dpi.X(420), Math.Max(Dpi.X(180), ClientSize.Width - Pad * 2 - Dpi.X(40))); } }

        public ChatView()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
            AutoScroll = true;
            BackColor = Theme.Bg;
            Padding = new Padding(0);
        }

        public void Add(bool user, string text)
        {
            Add(user, text, null);
        }

        public void Add(bool user, string text, string files)
        {
            Msg m = new Msg();
            m.User = user;
            m.Kind = user ? "user" : "ai";
            m.Text = text ?? "";
            m.Files = files ?? "";
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
            m.Time = DateTime.Now.ToString("HH:mm");
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
            int h = Math.Max(0, contentHeight - ClientSize.Height + Dpi.X(18));
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

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Reflow();
            Invalidate();
        }

        // 量一个气泡：宽、高（含内部附件行）
        void Measure(Msg m, out int w, out int h)
        {
            if (m.Kind == "note") { w = 0; h = Dpi.X(36); return; }
            Size sz = TextRenderer.MeasureText(m.Text.Length == 0 ? " " : m.Text, font,
                new Size(Math.Max(Dpi.X(80), MaxBubble - Dpi.X(28)), int.MaxValue), TextFormatFlags.WordBreak);
            int filesH = string.IsNullOrEmpty(m.Files) ? 0 : Dpi.X(20);
            w = Math.Min(Math.Max(sz.Width + Dpi.X(28), Dpi.X(58)), MaxBubble);
            h = sz.Height + filesH + Dpi.X(26);
        }

        int RowHeight(Msg m)
        {
            if (m.Kind == "note") return Dpi.X(36);
            int w, h;
            Measure(m, out w, out h);
            return LabelH + h + Gap;
        }

        void Reflow()
        {
            int y = Dpi.X(16);
            tops.Clear();
            foreach (Msg m in msgs)
            {
                int h = RowHeight(m);
                tops.Add(new int[] { y, h });
                y += h;
            }
            contentHeight = y;
            AutoScrollMinSize = new Size(0, y + Dpi.X(8));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.Bg);
            if (msgs.Count == 0)
            {
                DrawEmpty(g);
                return;
            }
            // WinForms 的 AutoScrollPosition getter 返回负的滚动量（往下滚 = 负数），
            // 所以要「加上」它才是内容在视口里的 y。
            int y = Dpi.X(16) + AutoScrollPosition.Y;
            foreach (Msg m in msgs)
            {
                if (m.Kind == "note")
                {
                    DrawNote(g, m, y);
                    y += Dpi.X(36);
                    continue;
                }
                int bw, bh;
                Measure(m, out bw, out bh);
                int bubbleTop = y + LabelH;
                if (bubbleTop + bh < 0) { y += LabelH + bh + Gap; continue; }
                bool user = m.Kind == "user";
                int x = user ? (ClientSize.Width - Pad - bw) : Pad;

                // 名字和时间放气泡上面一行，比压在气泡下沿好读
                string label = (user ? "你" : "鲸倩") + "  " + m.Time;
                Rectangle lr = user
                    ? new Rectangle(x + bw - Dpi.X(140), y, Dpi.X(140), LabelH)
                    : new Rectangle(x, y, Dpi.X(140), LabelH);
                TextRenderer.DrawText(g, label, meta, lr, Theme.Dim,
                    (user ? TextFormatFlags.Right : TextFormatFlags.Left) | TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

                Rectangle rr = new Rectangle(x, bubbleTop, bw, bh);
                using (GraphicsPath gp = Theme.Round(rr, Radius))
                {
                    using (SolidBrush fill = new SolidBrush(user ? Theme.UserBubble : Theme.AiBubble))
                        g.FillPath(fill, gp);
                    if (!user)
                        using (Pen p = new Pen(Theme.Border, 1f)) g.DrawPath(p, gp);
                }
                int innerX = x + Dpi.X(14);
                int innerW = bw - Dpi.X(28);
                int textTop = bubbleTop + Dpi.X(12);
                if (!string.IsNullOrEmpty(m.Files))
                {
                    TextRenderer.DrawText(g, "附件 · " + m.Files, meta,
                        new Rectangle(innerX, bubbleTop + Dpi.X(8), innerW, Dpi.X(18)), Theme.AccentDeep,
                        TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
                    textTop += Dpi.X(20);
                }
                Rectangle tr = new Rectangle(innerX, textTop, innerW, bh - (textTop - bubbleTop) - Dpi.X(12));
                TextRenderer.DrawText(g, m.Text, font, tr, m.Kind == "pending" ? Theme.Dim : Theme.Text,
                    TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
                y += LabelH + bh + Gap;
            }
        }

        void DrawNote(Graphics g, Msg m, int y)
        {
            Size sz = TextRenderer.MeasureText(m.Text, noteFont,
                new Size(Math.Max(Dpi.X(120), ClientSize.Width - Dpi.X(80)), int.MaxValue), TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            int w = Math.Min(sz.Width + Dpi.X(26), ClientSize.Width - Dpi.X(40));
            int h = Dpi.X(26);
            int x = (ClientSize.Width - w) / 2;
            Rectangle rr = new Rectangle(x, y + Dpi.X(4), w, h);
            using (GraphicsPath gp = Theme.Round(rr, Dpi.X(9)))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(236, 243, 249))) g.FillPath(b, gp);
            }
            TextRenderer.DrawText(g, m.Text, noteFont, rr, Theme.Dim,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        }

        void DrawEmpty(Graphics g)
        {
            int cy = (int)(ClientSize.Height * 0.30);
            int icon = Dpi.X(52);
            Rectangle ir = new Rectangle((ClientSize.Width - icon) / 2, cy, icon, icon);
            if (EmptyIcon != null)
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(EmptyIcon, ir);
            }
            else
            {
                using (GraphicsPath gp = Theme.Round(ir, Dpi.X(16)))
                using (SolidBrush b = new SolidBrush(Theme.UserBubble)) g.FillPath(b, gp);
            }
            string title = "在呢";
            Size ts = TextRenderer.MeasureText(title, emptyTitle);
            TextRenderer.DrawText(g, title, emptyTitle,
                new Rectangle(0, ir.Bottom + Dpi.X(14), ClientSize.Width, ts.Height + Dpi.X(6)),
                Theme.Text, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
            string hint = "说点什么，或者把文件 / 图片拖进来。";
            TextRenderer.DrawText(g, hint, emptyHint,
                new Rectangle(0, ir.Bottom + Dpi.X(14) + ts.Height + Dpi.X(12), ClientSize.Width, Dpi.X(26)),
                Theme.Dim, TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, "回车发送 · Shift+回车换行 · 拖进来的文件会贴在输入框上方",
                emptyTiny,
                new Rectangle(0, ir.Bottom + Dpi.X(14) + ts.Height + Dpi.X(42), ClientSize.Width, Dpi.X(22)),
                Color.FromArgb(164, 178, 190), TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding);
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

    // 拖进输入栏的附件（界面只记路径和名字，文件内容由服务端读）
    class AttachItem
    {
        public string Path;
        public string Name;
        public string Kind;
        public long Size;
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
        Panel bottom;
        Panel topHost;
        Panel toolPanel;
        Label dragHintLabel;
        int toolBorderY;
        FlowLayoutPanel attachBar;
        Label inputHint;
        readonly List<AttachItem> attachments = new List<AttachItem>();
        CaptionBar caption;
        NotifyIcon tray;
        Label statsLabel;
        Label clockLabel;
        Panel radarBar;
        Label radarLabel;
        Button radarGoBtn;
        Button radarLaterBtn;
        ToolTip tip;
        int statTick;
        public bool VerifyOnly;
        public bool DumpBubbles;
        public string DumpShotPath;
        public int DumpCount;
        public string AutoSendText;
        System.Windows.Forms.Timer statusTimer;
        bool sending;
        // 语音：本机朗读 + 麦克风听写（不联网）
        bool voiceOn;
        string voiceName = "";
        int voiceRate = 0;
        SpeechSynthesizer tts;
        Button btnVoice;
        Button btnMic;
        bool recognizing;
        // 模型快捷切换 + 今日账单（常驻工具栏右侧）
        ComboBox modelBox;
        Label costLabel;
        bool routeFilling;
        int toolRight;

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
            // UI 复查用：JQ_UI_SIZE=720x520 可以按指定逻辑尺寸开窗（截图看小窗有没有挤坏）
            string uiSize = Environment.GetEnvironmentVariable("JQ_UI_SIZE");
            if (!string.IsNullOrEmpty(uiSize))
            {
                string[] wh = uiSize.ToLower().Split('x');
                int uw, uh;
                if (wh.Length == 2 && int.TryParse(wh[0], out uw) && int.TryParse(wh[1], out uh))
                    Size = new Size(Dpi.X(uw), Dpi.X(uh));
            }
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
            LoadVoiceConfig();

            // 截图/验收用：JQ_UI_ATTACH=路径1;路径2 自动贴上附件（等价于拖进来）
            string uiAttach = Environment.GetEnvironmentVariable("JQ_UI_ATTACH");
            if (!string.IsNullOrEmpty(uiAttach)) AddAttachments(uiAttach.Split(';'));

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
                        // 验收/截图用钩子：JQ_RADAR_DEMO=1 时先同步问一次雷达，让截图能拍到顶部横条
                        if (Environment.GetEnvironmentVariable("JQ_RADAR_DEMO") == "1")
                        {
                            try
                            {
                                Dictionary<string, object> rd = api.Get("/api/radar", 5000);
                                object arr;
                                if (rd.TryGetValue("new", out arr) && arr is object[] && ((object[])arr).Length > 0)
                                {
                                    ShowRadarBar(((object[])arr).Length, "");
                                    Application.DoEvents();
                                    System.Threading.Thread.Sleep(150);
                                    Application.DoEvents();
                                }
                            }
                            catch { }
                        }
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
                    if (ok && !VerifyOnly) CheckRadar();
                    if (ok && !VerifyOnly && !DumpBubbles) CheckFirstRun();
                    if (ok && Environment.GetEnvironmentVariable("JQ_DEMO_SEQ") == "1") StartDemoSequence();
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
                LayoutTop();
                LayoutBottom();
            };
            FormClosing += delegate
            {
                if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
                try { if (tts != null) { tts.SpeakAsyncCancelAll(); tts.Dispose(); tts = null; } } catch { }
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
                if (statTick % 4 == 0) RefreshCost();
            };
            statusTimer.Start();
            LoadRoute();
            RefreshCost();
        }

        void BuildUi()
        {
            // ---- 顶部容器：标题栏在最上，工具栏第二，雷达条第三 ----
            // 以前三块都用 Dock.Top，谁最后加谁跑最上面，结果工具栏压到了标题栏上。
            // 现在统一放一个容器里手动排版，顺序写死，不会再反。
            topHost = new Panel();
            topHost.Dock = DockStyle.Top;
            topHost.Height = Dpi.X(88);
            topHost.BackColor = Theme.Paper;
            Controls.Add(topHost);

            caption = new CaptionBar();
            caption.AppIcon = LoadSmallIcon();
            caption.MinClick += delegate { WindowState = FormWindowState.Minimized; };
            caption.MaxClick += delegate
            {
                WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
            };
            caption.CloseClick += delegate { HideToTray(); };
            caption.MouseDown += DragWindow;
            topHost.Controls.Add(caption);

            // 工具栏（文字按钮，不用 emoji——有些机器上 emoji 会变方块）
            toolPanel = new Panel();
            toolPanel.BackColor = Theme.Bg;
            toolPanel.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f))
                    e.Graphics.DrawLine(p, 0, toolBorderY, toolPanel.Width, toolBorderY);
            };
            topHost.Controls.Add(toolPanel);

            int tx = Dpi.X(12);
            ToolBtn(toolPanel, ref tx, "新对话", false, delegate
            {
                chatView.Clear();
                caption.StatusText = "已清空显示";
                caption.Invalidate();
            });
            ToolBtn(toolPanel, ref tx, "状态", false, delegate { ShowStatus(); });
            ToolBtn(toolPanel, ref tx, "记忆", false, delegate { OpenMemory(); });
            ToolBtn(toolPanel, ref tx, "插件", false, delegate { OpenPlugins(); });
            ToolBtn(toolPanel, ref tx, "设置", true, delegate { OpenSettings(); });
            btnVoice = ToolBtn(toolPanel, ref tx, "朗读", false, delegate { ToggleVoice(); });

            // 模型快捷切换：下拉里点一下就换，不用进设置、不用重启服务
            modelBox = new ComboBox();
            modelBox.DropDownStyle = ComboBoxStyle.DropDownList;
            modelBox.FlatStyle = FlatStyle.Flat;
            modelBox.Font = Theme.Ui(9f, false);
            modelBox.BackColor = Color.White;
            modelBox.ForeColor = Theme.Text;
            modelBox.Items.Add("模型：读取中…");
            modelBox.SelectedIndex = 0;
            modelBox.SelectedIndexChanged += delegate { OnModelPicked(); };
            toolPanel.Controls.Add(modelBox);

            // 今日花费：常驻显示，点开是明细 + 重置
            costLabel = new Label();
            costLabel.AutoSize = false;
            costLabel.TextAlign = ContentAlignment.MiddleCenter;
            costLabel.Font = Theme.Ui(8.5f, true);
            costLabel.ForeColor = Theme.AccentDeep;
            costLabel.BackColor = Color.White;
            costLabel.Text = "今日 —";
            costLabel.Cursor = Cursors.Hand;
            costLabel.Click += delegate { ShowCostDialog(); };
            toolPanel.Controls.Add(costLabel);
            toolRight = tx;

            dragHintLabel = new Label();
            dragHintLabel.AutoSize = false;
            dragHintLabel.TextAlign = ContentAlignment.MiddleRight;
            dragHintLabel.ForeColor = Color.FromArgb(160, 176, 190);
            dragHintLabel.Font = Theme.Ui(8.5f, false);
            dragHintLabel.Text = "文件 / 图片可以直接拖进来";
            toolPanel.Controls.Add(dragHintLabel);

            // 免费模型雷达条：整条横在工具栏下面；平时藏着，发现新的免费模型才出现。
            // 只提示，不自动写密钥、不自动启用；「以后再说」= 记为已读。
            radarBar = new Panel();
            radarBar.BackColor = Color.FromArgb(255, 250, 232);
            radarBar.Visible = false;
            radarBar.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Color.FromArgb(240, 224, 186), 1f))
                    e.Graphics.DrawLine(p, 0, radarBar.Height - 1, radarBar.Width, radarBar.Height - 1);
            };
            radarLabel = new Label();
            radarLabel.AutoSize = false;
            radarLabel.TextAlign = ContentAlignment.MiddleLeft;
            radarLabel.ForeColor = Theme.AccentDeep;
            radarLabel.Font = Theme.Ui(9f, false);
            radarBar.Controls.Add(radarLabel);

            radarGoBtn = MakeButton("去配置", Theme.Accent, Color.White);
            radarGoBtn.Font = Theme.Ui(8.5f, true);
            radarGoBtn.Click += delegate { HideRadarBar(); OpenSettings(); };
            radarBar.Controls.Add(radarGoBtn);

            radarLaterBtn = MakeButton("以后再说", Color.White, Theme.AccentDeep);
            radarLaterBtn.Font = Theme.Ui(8.5f, true);
            radarLaterBtn.Click += delegate { HideRadarBar(); AckRadar(); };
            radarBar.Controls.Add(radarLaterBtn);

            topHost.Controls.Add(radarBar);

            // ---- 底部输入区 ----
            bottom = new Panel();
            bottom.Dock = DockStyle.Bottom;
            bottom.Height = Dpi.X(112);
            bottom.BackColor = Theme.Paper;
            bottom.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f)) e.Graphics.DrawLine(p, 0, 0, bottom.Width, 0);
            };

            attachBar = new FlowLayoutPanel();
            attachBar.FlowDirection = FlowDirection.LeftToRight;
            attachBar.WrapContents = false;
            attachBar.AutoScroll = true;
            attachBar.Visible = false;
            attachBar.BackColor = Theme.Paper;
            bottom.Controls.Add(attachBar);

            inputWrap = new Panel();
            inputWrap.BackColor = Theme.Bg;
            inputWrap.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color line = dropHover ? Theme.Accent : Theme.Border;
                using (GraphicsPath gp = Theme.Round(new Rectangle(0, 0, inputWrap.Width - 1, inputWrap.Height - 1), Dpi.X(12)))
                {
                    using (SolidBrush b = new SolidBrush(dropHover ? Color.FromArgb(246, 252, 255) : Color.White)) e.Graphics.FillPath(b, gp);
                    using (Pen p = new Pen(line, dropHover ? 2f : 1f)) e.Graphics.DrawPath(p, gp);
                }
            };
            bottom.Controls.Add(inputWrap);

            input = new TextBox();
            input.Multiline = true;
            input.BorderStyle = BorderStyle.None;
            input.BackColor = Color.White;
            input.ForeColor = Theme.Text;
            input.Font = Theme.Ui(10f, false);
            input.ScrollBars = ScrollBars.None;
            input.AcceptsTab = false;
            input.SetBounds(Dpi.X(12), Dpi.X(9), Dpi.X(280), Dpi.X(46));
            input.TextChanged += delegate
            {
                SyncInputScrollbar();
                UpdateInputHint();
            };
            input.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter && !e.Shift && !e.Control)
                {
                    e.SuppressKeyPress = true;
                    SendCurrent();
                }
            };
            inputWrap.Controls.Add(input);

            inputHint = new Label();
            inputHint.AutoSize = false;
            inputHint.BackColor = Color.White;
            inputHint.TextAlign = ContentAlignment.TopLeft;
            inputHint.ForeColor = Color.FromArgb(170, 184, 196);
            inputHint.Font = Theme.Ui(9.5f, false);
            inputHint.Text = "说点什么…（回车发送，Shift+回车换行）";
            inputHint.Cursor = Cursors.IBeam;
            inputHint.Click += delegate { input.Focus(); };
            inputWrap.Controls.Add(inputHint);
            inputHint.BringToFront();

            sendBtn = MakeButton("发送", Theme.Accent, Color.White);
            sendBtn.Font = Theme.Ui(10f, true);
            sendBtn.Click += delegate { SendCurrent(); };
            bottom.Controls.Add(sendBtn);

            // 麦克风听写：本机识别（zh-CN），不联网
            btnMic = MakeButton("说话", Color.White, Theme.AccentDeep);
            btnMic.Font = Theme.Ui(9f, true);
            btnMic.Click += delegate { MicOnce(); };
            bottom.Controls.Add(btnMic);

            // 底部数据栏：tok/s · 缓存 · 上下文 · 今日调用 · 走哪家 · 时钟
            statsLabel = new Label();
            statsLabel.AutoSize = false;
            statsLabel.Text = "数据栏：连上服务后显示";
            statsLabel.ForeColor = Theme.Dim;
            statsLabel.Font = Theme.Ui(8.5f, false);
            bottom.Controls.Add(statsLabel);
            clockLabel = new Label();
            clockLabel.AutoSize = false;
            clockLabel.TextAlign = ContentAlignment.TopRight;
            clockLabel.ForeColor = Theme.Dim;
            clockLabel.Font = Theme.Ui(8.5f, false);
            bottom.Controls.Add(clockLabel);
            tip = new ToolTip();
            tip.SetToolTip(statsLabel, "鼠标停在这里看今天用量");
            Controls.Add(bottom);

            chatView = new ChatView();
            chatView.Dock = DockStyle.Fill;
            Controls.Add(chatView);
            chatView.BringToFront();
            chatView.EmptyIcon = LoadEmptyIcon();

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

            // 拖文件/图片进来（主窗口、消息区、输入区都收）
            HookDrop(this);
            HookDrop(chatView);
            HookDrop(inputWrap);
            HookDrop(input);

            LayoutTop();
            LayoutBottom();
            UpdateInputHint();
        }

        // 工具栏按钮：secondary 白底蓝字，primary 蓝底白字
        Button ToolBtn(Panel host, ref int x, string text, bool primary, EventHandler click)
        {
            Button b = MakeButton(text, primary ? Theme.Accent : Color.White, primary ? Color.White : Theme.AccentDeep);
            b.SetBounds(x, Dpi.X(7), TextWidth(text), Dpi.X(26));
            b.Click += click;
            host.Controls.Add(b);
            x += b.Width + Dpi.X(6);
            return b;
        }

        void LayoutTop()
        {
            if (topHost == null || caption == null || toolPanel == null) return;
            int w = ClientSize.Width;
            bool radar = radarBar != null && radarBar.Visible;
            topHost.Height = Dpi.X(radar ? 122 : 88);
            caption.SetBounds(0, 0, w, Dpi.X(48));
            toolPanel.SetBounds(0, Dpi.X(48), w, Dpi.X(40));
            toolBorderY = toolPanel.Height - 1;
            radarBar.SetBounds(0, Dpi.X(88), w, Dpi.X(34));
            if (radarGoBtn != null)
            {
                radarLaterBtn.SetBounds(w - Dpi.X(12) - radarLaterBtn.Width, Dpi.X(4), radarLaterBtn.Width, Dpi.X(26));
                radarGoBtn.SetBounds(radarLaterBtn.Left - Dpi.X(8) - radarGoBtn.Width, Dpi.X(4), radarGoBtn.Width, Dpi.X(26));
                radarLabel.SetBounds(Dpi.X(16), 0, Math.Max(Dpi.X(120), radarGoBtn.Left - Dpi.X(28)), Dpi.X(34));
            }
            // 右侧先排「今日花费」和「模型下拉」，提示字夹在按钮和它们中间
            int rightEdge = toolPanel.Width - Dpi.X(12);
            if (costLabel != null)
            {
                costLabel.SetBounds(rightEdge - Dpi.X(92), Dpi.X(7), Dpi.X(92), Dpi.X(26));
                rightEdge = costLabel.Left - Dpi.X(8);
            }
            if (modelBox != null)
            {
                modelBox.SetBounds(rightEdge - Dpi.X(172), Dpi.X(7), Dpi.X(172), Dpi.X(26));
                rightEdge = modelBox.Left - Dpi.X(8);
            }
            if (dragHintLabel != null)
            {
                int left = toolRight + Dpi.X(10);
                int width = rightEdge - left - Dpi.X(4);
                dragHintLabel.Visible = width > Dpi.X(110);
                dragHintLabel.SetBounds(left, 0, Math.Max(0, width), toolPanel.Height);
            }
        }

        void LayoutBottom()
        {
            if (bottom == null || inputWrap == null || sendBtn == null) return;
            bool hasAttach = attachments.Count > 0;
            int inputTop = hasAttach ? Dpi.X(42) : Dpi.X(12);
            bottom.Height = hasAttach ? Dpi.X(148) : Dpi.X(112);
            if (attachBar != null)
            {
                attachBar.Visible = hasAttach;
                attachBar.SetBounds(Dpi.X(14), Dpi.X(9), Math.Max(Dpi.X(120), bottom.ClientSize.Width - Dpi.X(28)), Dpi.X(26));
            }
            int micW = Dpi.X(64);
            int rightW = Dpi.X(86) + Dpi.X(8) + micW;
            int avail = Math.Max(Dpi.X(160), bottom.ClientSize.Width - Dpi.X(28) - rightW - Dpi.X(10));
            inputWrap.SetBounds(Dpi.X(14), inputTop, avail, Dpi.X(64));
            input.SetBounds(Dpi.X(12), Dpi.X(9), avail - Dpi.X(24), Dpi.X(46));
            inputHint.SetBounds(Dpi.X(15), Dpi.X(11), avail - Dpi.X(30), Dpi.X(24));
            btnMic.SetBounds(inputWrap.Right + Dpi.X(10), inputTop + Dpi.X(11), micW, Dpi.X(42));
            sendBtn.SetBounds(btnMic.Right + Dpi.X(8), inputTop + Dpi.X(11), Dpi.X(86), Dpi.X(42));
            statsLabel.SetBounds(Dpi.X(16), bottom.Height - Dpi.X(24), Math.Max(Dpi.X(160), bottom.ClientSize.Width - Dpi.X(120)), Dpi.X(18));
            clockLabel.SetBounds(bottom.ClientSize.Width - Dpi.X(86), bottom.Height - Dpi.X(24), Dpi.X(70), Dpi.X(18));
        }

        // 输入框内容少的时候不显示滚动条，超过三行才给
        void SyncInputScrollbar()
        {
            try
            {
                bool need = input.Lines.Length > 3 || input.Text.Length > 160;
                ScrollBars want = need ? ScrollBars.Vertical : ScrollBars.None;
                if (input.ScrollBars != want) input.ScrollBars = want;
            }
            catch { }
        }

        void UpdateInputHint()
        {
            if (inputHint == null || input == null) return;
            inputHint.Visible = input.Text.Length == 0;
            if (attachments.Count > 0)
                inputHint.Text = "再加一句话也行，直接发送也可以";
            else
                inputHint.Text = "说点什么…（回车发送，Shift+回车换行）";
        }

        // ---------- 拖文件 / 图片 ----------
        bool dropHover;

        void SetDropHover(bool on)
        {
            if (dropHover == on) return;
            dropHover = on;
            if (inputWrap != null) inputWrap.Invalidate();
            if (inputHint != null && on)
            {
                inputHint.Visible = true;
                inputHint.Text = "松手就贴到输入框上方";
            }
            else UpdateInputHint();
        }

        void HookDrop(Control c)
        {
            if (c == null) return;
            c.AllowDrop = true;
            c.DragEnter += delegate (object s, DragEventArgs e)
            {
                if (e.Data != null && e.Data.GetDataPresent(DataFormats.FileDrop))
                {
                    e.Effect = DragDropEffects.Copy;
                    SetDropHover(true);
                }
                else e.Effect = DragDropEffects.None;
            };
            c.DragLeave += delegate { SetDropHover(false); };
            c.DragDrop += delegate (object s, DragEventArgs e)
            {
                SetDropHover(false);
                if (e.Data == null || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                try { AddAttachments((string[])e.Data.GetData(DataFormats.FileDrop)); }
                catch (Exception ex) { caption.StatusText = "贴附件失败：" + ex.Message; caption.Invalidate(); }
            };
        }

        void AddAttachments(string[] paths)
        {
            if (paths == null) return;
            int added = 0;
            foreach (string raw in paths)
            {
                if (string.IsNullOrEmpty(raw)) continue;
                if (attachments.Count >= 6) break;
                string p;
                try { p = Path.GetFullPath(raw); } catch { continue; }
                if (!File.Exists(p)) continue;
                bool dup = false;
                foreach (AttachItem x in attachments)
                    if (string.Equals(x.Path, p, StringComparison.OrdinalIgnoreCase)) { dup = true; break; }
                if (dup) continue;
                FileInfo fi = new FileInfo(p);
                string ext = Path.GetExtension(p).ToLowerInvariant();
                bool img = ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" || ext == ".bmp";
                attachments.Add(new AttachItem { Path = p, Name = fi.Name, Size = fi.Length, Kind = img ? "图片" : "文件" });
                added++;
            }
            if (added > 0)
            {
                caption.StatusText = "已贴上 " + attachments.Count + " 个附件，发送时一起带上";
                caption.Invalidate();
            }
            RebuildAttachChips();
            LayoutBottom();
            UpdateInputHint();
        }

        void RebuildAttachChips()
        {
            if (attachBar == null) return;
            attachBar.SuspendLayout();
            attachBar.Controls.Clear();
            foreach (AttachItem it in attachments)
            {
                string label = it.Name.Length > 16 ? it.Name.Substring(0, 15) + "…" : it.Name;
                string text = label + "  ×";
                FlatBtn b = new FlatBtn(text, Color.FromArgb(230, 241, 250), Theme.AccentDeep);
                b.Font = Theme.Ui(8.5f, false);
                b.Radius = 11;
                b.Size = new Size(TextRenderer.MeasureText(text, b.Font).Width + Dpi.X(18), Dpi.X(24));
                b.Margin = new Padding(0, 0, Dpi.X(6), 0);
                AttachItem captured = it;
                b.Click += delegate
                {
                    attachments.Remove(captured);
                    RebuildAttachChips();
                    LayoutBottom();
                    UpdateInputHint();
                };
                tip.SetToolTip(b, it.Kind + " · " + HumanSize(it.Size) + " · 点一下就撤掉");
                attachBar.Controls.Add(b);
            }
            attachBar.ResumeLayout();
        }

        static string HumanSize(long n)
        {
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) return (n / 1024) + " KB";
            return (n / 1024.0 / 1024.0).ToString("0.0") + " MB";
        }

        int TextWidth(string text)
        {
            return TextRenderer.MeasureText(text, Theme.Ui(9f, true)).Width + Dpi.X(22);
        }

        // ---------- 免费模型雷达提示条：显隐 / 后台问一次 ----------
        void ShowRadarBar(int n, string sample)
        {
            if (radarBar == null) return;
            // 字数控制在一条内：具体是哪几个模型，去设置页看（横条里不塞长名字）
            radarLabel.Text = "发现 " + n + " 个新的免费模型，要现在配置吗？";
            radarBar.Visible = true;
            LayoutTop();
            radarBar.Invalidate();
        }

        void HideRadarBar()
        {
            if (radarBar == null) return;
            radarBar.Visible = false;
            LayoutTop();
        }

        // 只读服务里的缓存，不在 UI 线程里联网
        void CheckRadar()
        {
            System.Threading.ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                int n = 0;
                string sample = "";
                try
                {
                    Dictionary<string, object> r = api.Get("/api/radar", 5000);
                    object arr;
                    if (r.TryGetValue("new", out arr) && arr is object[])
                    {
                        foreach (object o in (object[])arr)
                        {
                            Dictionary<string, object> d = o as Dictionary<string, object>;
                            if (d == null) continue;
                            n++;
                            if (sample.Length == 0 && d.ContainsKey("model")) sample = Convert.ToString(d["model"]);
                        }
                    }
                }
                catch { return; }
                if (n <= 0) return;
                try
                {
                    BeginInvoke((MethodInvoker)delegate { ShowRadarBar(n, sample); });
                }
                catch { }
            });
        }

        // 「以后再说」：让服务把这几条记成已读，下次不再提醒
        void AckRadar()
        {
            System.Threading.ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                try
                {
                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["all"] = true;
                    api.Post("/api/radar/ack", body, 5000);
                }
                catch { }
            });
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

        // ===================== 模型快捷切换 =====================
        class RouteOption
        {
            public string Label = "";
            public string Pin = "";
            public string Mode = "";
            public bool Current;
            public override string ToString() { return Label; }
        }

        void LoadRoute()
        {
            System.Threading.ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                Dictionary<string, object> j = null;
                try { j = api.Get("/api/route", 5000); } catch { j = null; }
                try { BeginInvoke((MethodInvoker)delegate { FillRouteCombo(j); }); } catch { }
            });
        }

        void FillRouteCombo(Dictionary<string, object> j)
        {
            if (modelBox == null) return;
            routeFilling = true;
            try
            {
                modelBox.Items.Clear();
                if (j == null)
                {
                    modelBox.Items.Add(new RouteOption { Label = "模型：服务没接上" });
                    modelBox.SelectedIndex = 0;
                    return;
                }
                string mode = "cheap-first";
                List<string> order = new List<string>();
                object ro;
                if (j.TryGetValue("route", out ro) && ro is Dictionary<string, object>)
                {
                    Dictionary<string, object> rd = (Dictionary<string, object>)ro;
                    if (rd.ContainsKey("mode")) mode = Convert.ToString(rd["mode"]);
                    object oo;
                    if (rd.TryGetValue("order", out oo) && oo is object[])
                        foreach (object x in (object[])oo) order.Add(Convert.ToString(x));
                }
                string pinned = (mode == "fixed" && order.Count > 0) ? order[0] : null;

                RouteOption a1 = new RouteOption { Label = "自动：先免费 / 本地", Mode = "cheap-first", Current = pinned == null && mode == "cheap-first" };
                RouteOption a2 = new RouteOption { Label = "自动：先云端", Mode = "cloud-first", Current = pinned == null && mode == "cloud-first" };
                modelBox.Items.Add(a1);
                modelBox.Items.Add(a2);

                int current = a1.Current ? 0 : (a2.Current ? 1 : -1);
                object pv;
                if (j.TryGetValue("providers", out pv) && pv is object[])
                {
                    foreach (object o in (object[])pv)
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d == null || !d.ContainsKey("name")) continue;
                        string name = Convert.ToString(d["name"]);
                        bool free = d.ContainsKey("free") && Convert.ToBoolean(d["free"]);
                        bool ready = d.ContainsKey("ready") && Convert.ToBoolean(d["ready"]);
                        string label = name;
                        if (d.ContainsKey("model")) label += "（" + Convert.ToString(d["model"]) + "）";
                        if (free) label += " 免费";
                        if (!ready) label += " · 未配置";
                        RouteOption op = new RouteOption { Label = label, Pin = name, Current = pinned == name };
                        modelBox.Items.Add(op);
                        if (op.Current) current = modelBox.Items.Count - 1;
                    }
                }
                modelBox.SelectedIndex = current >= 0 ? current : 0;
            }
            finally
            {
                routeFilling = false;
            }
        }

        void OnModelPicked()
        {
            if (routeFilling || modelBox == null || modelBox.SelectedIndex < 0) return;
            RouteOption opt = modelBox.SelectedItem as RouteOption;
            if (opt == null) return;
            if (opt.Pin.Length == 0 && opt.Mode.Length == 0) return;
            if (opt.Current) return;
            System.Threading.ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                string err = null;
                try
                {
                    Dictionary<string, object> body = new Dictionary<string, object>();
                    if (opt.Pin.Length > 0) body["pin"] = opt.Pin;
                    else body["mode"] = opt.Mode;
                    Dictionary<string, object> r = api.Post("/api/route", body, 8000);
                    if (r.ContainsKey("ok") && !Convert.ToBoolean(r["ok"])) err = Convert.ToString(r["error"]);
                }
                catch (Exception ex) { err = ex.Message; }
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        caption.StatusText = err == null ? ("已切到 " + opt.Label + "，下一轮就走它") : ("切换失败：" + err);
                        caption.Invalidate();
                        LoadRoute();
                    });
                }
                catch { }
            });
        }

        // ===================== 今日账单 =====================
        void RefreshCost()
        {
            if (costLabel == null) return;
            System.Threading.ThreadPool.QueueUserWorkItem(delegate (object state)
            {
                string text = "今日 —";
                string tipText = "今天还没有调用";
                try
                {
                    Dictionary<string, object> j = api.Get("/api/cost?days=7", 5000);
                    double cost = 0;
                    string calls = "0";
                    object t;
                    if (j.TryGetValue("today", out t) && t is Dictionary<string, object>)
                    {
                        Dictionary<string, object> td = (Dictionary<string, object>)t;
                        if (td.ContainsKey("cost")) cost = Convert.ToDouble(td["cost"]);
                        if (td.ContainsKey("calls")) calls = Convert.ToString(td["calls"]);
                    }
                    text = "今日 ¥" + cost.ToString("0.000");
                    double total = 0;
                    if (j.ContainsKey("total")) total = Convert.ToDouble(j["total"]);
                    tipText = "今天调用 " + calls + " 次 · 今日 ¥" + cost.ToString("0.000")
                        + " · 近 7 天 ¥" + total.ToString("0.000") + "（点开看明细和重置）";
                }
                catch { text = "今日 —"; }
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (costLabel == null) return;
                        costLabel.Text = text;
                        tip.SetToolTip(costLabel, tipText);
                        costLabel.Invalidate();
                    });
                }
                catch { }
            });
        }

        void ShowCostDialog()
        {
            Dictionary<string, object> j = null;
            try { j = api.Get("/api/cost?days=7", 5000); }
            catch (Exception ex)
            {
                MessageBox.Show(this, "服务没接上，账单读不到：" + ex.Message, "今日账单", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            using (Form f = MakeCostForm(j)) f.ShowDialog(this);
            RefreshCost();
        }

        internal Form MakeCostForm(Dictionary<string, object> j)
        {
            double todayCost = 0, total = 0;
            string calls = "0", resetAt = "";
            List<string> rows = new List<string>();
            object t;
            if (j.TryGetValue("today", out t) && t is Dictionary<string, object>)
            {
                Dictionary<string, object> td = (Dictionary<string, object>)t;
                if (td.ContainsKey("cost")) todayCost = Convert.ToDouble(td["cost"]);
                if (td.ContainsKey("calls")) calls = Convert.ToString(td["calls"]);
                object pv;
                if (td.TryGetValue("providers", out pv) && pv is object[])
                {
                    foreach (object o in (object[])pv)
                    {
                        Dictionary<string, object> d = o as Dictionary<string, object>;
                        if (d == null || !d.ContainsKey("name")) continue;
                        double pc = d.ContainsKey("cost") ? Convert.ToDouble(d["cost"]) : 0;
                        string cl = d.ContainsKey("calls") ? Convert.ToString(d["calls"]) : "0";
                        rows.Add(Convert.ToString(d["name"]) + " · " + cl + " 次 · ¥" + pc.ToString("0.000"));
                    }
                }
            }
            if (j.ContainsKey("total")) total = Convert.ToDouble(j["total"]);
            object rr;
            if (j.TryGetValue("reset", out rr) && rr is Dictionary<string, object>)
            {
                Dictionary<string, object> rd = (Dictionary<string, object>)rr;
                if (rd.ContainsKey("at")) resetAt = Convert.ToString(rd["at"]).Replace('T', ' ');
                if (resetAt.Length > 16) resetAt = resetAt.Substring(0, 16);
            }
            if (rows.Count == 0) rows.Add("今天还没有调用");

            Form f = new Form();
            {
                f.Text = "今日账单";
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.StartPosition = FormStartPosition.CenterParent;
                f.MinimizeBox = false;
                f.MaximizeBox = false;
                f.ShowInTaskbar = false;
                f.Font = Theme.Ui(9f, false);
                f.BackColor = Theme.Paper;
                f.ClientSize = new Size(Dpi.X(340), Dpi.X(300));

                Label head = new Label();
                head.Text = "今日 ¥" + todayCost.ToString("0.000");
                head.Font = Theme.Ui(13f, true);
                head.ForeColor = Theme.AccentDeep;
                head.SetBounds(Dpi.X(18), Dpi.X(14), Dpi.X(304), Dpi.X(30));
                f.Controls.Add(head);

                Label body = new Label();
                body.Text = string.Join("\n", rows.ToArray())
                    + "\n\n近 7 天合计 ¥" + total.ToString("0.000")
                    + (resetAt.Length > 0 ? "\n上次重置：" + resetAt + "（只从那时起算）" : "");
                body.SetBounds(Dpi.X(18), Dpi.X(50), Dpi.X(304), Dpi.X(150));
                f.Controls.Add(body);

                Label note = new Label();
                note.Text = "金额按提供方单价估算；本地与免费模型记 0。重置不清账本，只是从现在重新累计。";
                note.ForeColor = Theme.Dim;
                note.Font = Theme.Ui(8f, false);
                note.SetBounds(Dpi.X(18), Dpi.X(196), Dpi.X(304), Dpi.X(46));
                f.Controls.Add(note);

                Button rb = MakeButton("重置今日", Color.White, Color.FromArgb(168, 66, 66));
                rb.SetBounds(Dpi.X(18), Dpi.X(250), Dpi.X(96), Dpi.X(30));
                rb.Click += delegate
                {
                    if (MessageBox.Show(f, "把今日显示的金额归零？原始账本不会删，只是从现在重新算。", "重置账单",
                        MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
                    string err = null;
                    try
                    {
                        Dictionary<string, object> req = new Dictionary<string, object>();
                        Dictionary<string, object> r = api.Post("/api/cost/reset", req, 8000);
                        if (r.ContainsKey("ok") && !Convert.ToBoolean(r["ok"])) err = Convert.ToString(r["error"]);
                    }
                    catch (Exception ex) { err = ex.Message; }
                    if (err != null) MessageBox.Show(f, "重置失败：" + err, "重置账单", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    else { f.DialogResult = DialogResult.OK; f.Close(); }
                };
                f.Controls.Add(rb);

                Button cb = MakeButton("关闭", Color.White, Theme.AccentDeep);
                cb.SetBounds(Dpi.X(226), Dpi.X(250), Dpi.X(96), Dpi.X(30));
                cb.Click += delegate { f.Close(); };
                f.Controls.Add(cb);

                return f;
            }
        }

        Button MakeButton(string text, Color back, Color fore)
        {
            FlatBtn b = new FlatBtn(text, back, fore);
            if (back == Color.White || back.GetBrightness() > 0.93f) b.NormalBorder = Theme.Border;
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

        // 空对话里的欢迎小图：用 app 图标放大，缺图时退回 null（ChatView 会画个色块）
        Image LoadEmptyIcon()
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
                if (File.Exists(ico)) return new Icon(ico, 48, 48).ToBitmap();
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

        // 录演示用：按剧本自己发几条（JQ_DEMO_SEQ=1），截图进程在外面按帧抓，不抢他的鼠标键盘
        void StartDemoSequence()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(900);
                DemoSend("记住：我下周三要交房租");
                DemoWait();
                Thread.Sleep(700);
                DemoSend("我什么时候要交房租？");
                DemoWait();
                Thread.Sleep(700);
                DemoSend("帮我把这周要交的房租和周四复查排个先后");
                DemoWait();
                Thread.Sleep(1800);
            });
        }

        void DemoSend(string text)
        {
            try { BeginInvoke((MethodInvoker)delegate { SendText(text); }); } catch { }
        }

        void DemoWait()
        {
            for (int i = 0; i < 300 && sending; i++) Thread.Sleep(150);
        }

        // 给纯小白：一家模型都没接上时，别让他对着空窗口发呆，直接问要不要去填密钥
        void CheckFirstRun()
        {
            try
            {
                Dictionary<string, object> sc = api.Get("/api/selfcheck", 4000);
                object ps;
                int ready = 0, total = 0;
                if (sc.TryGetValue("providers", out ps) && ps is object[])
                {
                    foreach (object o in (object[])ps)
                    {
                        Dictionary<string, object> p = o as Dictionary<string, object>;
                        if (p == null) continue;
                        total++;
                        // 本机 ollama 的 ready 只看 key（永远是 local），不代表真装了；单独探一下端口
                        if (Convert.ToString(p.ContainsKey("tier") ? p["tier"] : "") == "local") continue;
                        if (p.ContainsKey("ready") && Convert.ToBoolean(p["ready"])) ready++;
                    }
                }
                bool ollamaUp = false;
                try
                {
                    using (System.Net.Sockets.TcpClient c = new System.Net.Sockets.TcpClient())
                    {
                        IAsyncResult ar = c.BeginConnect("127.0.0.1", 11434, null, null);
                        ollamaUp = ar.AsyncWaitHandle.WaitOne(350) && c.Connected;
                    }
                }
                catch { }
                if (ready > 0 || ollamaUp || total == 0) return;
                DialogResult r = MessageBox.Show(this,
                    "还没接上模型，先填一家才能聊。\n\n"
                    + "推荐顺序：\n"
                    + "1）智谱 GLM-4-Flash —— 有免费额度，注册就能拿 key\n"
                    + "2）DeepSeek —— 便宜，几块钱能用很久\n"
                    + "3）本机 Ollama —— 完全免费，但要先装\n\n"
                    + "现在去填吗？填完关掉窗口重开就行。",
                    "鲸倩 · 第一次用", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (r == DialogResult.Yes) OpenSettings();
            }
            catch { }
        }

        // ---------- 语音：本机朗读 + 麦克风听写（都不联网） ----------
        void LoadVoiceConfig()
        {
            try
            {
                Dictionary<string, object> r = api.GetConfig(4000);
                Dictionary<string, object> cfg = (r.ContainsKey("config") && r["config"] is Dictionary<string, object>)
                    ? (Dictionary<string, object>)r["config"] : r;
                object v;
                if (cfg.TryGetValue("voice", out v) && v is Dictionary<string, object>)
                {
                    Dictionary<string, object> vo = (Dictionary<string, object>)v;
                    voiceOn = vo.ContainsKey("enabled") && Convert.ToBoolean(vo["enabled"]);
                    voiceName = vo.ContainsKey("voice") ? Convert.ToString(vo["voice"]) : "";
                    voiceRate = vo.ContainsKey("rate") ? Convert.ToInt32(vo["rate"]) : 0;
                }
            }
            catch { }
            UpdateVoiceButton();
        }

        void UpdateVoiceButton()
        {
            FlatBtn fb = btnVoice as FlatBtn;
            if (fb == null) return;
            fb.NormalBack = voiceOn ? Theme.Accent : Color.White;
            fb.NormalFore = voiceOn ? Color.White : Theme.AccentDeep;
            fb.NormalBorder = voiceOn ? Color.Transparent : Theme.Border;
            fb.Invalidate();
        }

        void ToggleVoice()
        {
            voiceOn = !voiceOn;
            UpdateVoiceButton();
            if (!voiceOn)
            {
                try { if (tts != null) tts.SpeakAsyncCancelAll(); } catch { }
            }
            caption.StatusText = voiceOn ? "朗读已开（点「朗读」可关）" : "朗读已关";
            caption.Invalidate();
        }

        static string CleanForSpeech(string s)
        {
            if (String.IsNullOrEmpty(s)) return "";
            s = s.Replace("**", "").Replace("`", "").Replace("#", "").Replace("* ", "");
            s = System.Text.RegularExpressions.Regex.Replace(s, @"工具 .*", "");
            return s.Trim();
        }

        void SpeakReply(string text)
        {
            if (!voiceOn) return;
            string t = CleanForSpeech(text);
            if (t.Length == 0) return;
            if (t.Length > 400) t = t.Substring(0, 400);
            try
            {
                if (tts == null) tts = Speech.Make(voiceName, voiceRate);
                tts.SpeakAsyncCancelAll();
                tts.SpeakAsync(t);
            }
            catch (Exception ex)
            {
                caption.StatusText = "朗读失败：" + ex.Message + "（设置里可以换声音）";
                caption.Invalidate();
            }
        }

        // 点一下「说话」：听一句中文，识别完填进输入框（不直接发送，给他看一眼改的机会）
        void MicOnce()
        {
            if (recognizing) return;
            recognizing = true;
            btnMic.Enabled = false;
            btnMic.Text = "听…";
            caption.StatusText = "在听，说完停一下…";
            caption.Invalidate();
            ThreadPool.QueueUserWorkItem(delegate
            {
                string heard = "";
                string err = "";
                try
                {
                    using (SpeechRecognitionEngine rec = new SpeechRecognitionEngine(new CultureInfo("zh-CN")))
                    {
                        rec.SetInputToDefaultAudioDevice();
                        rec.LoadGrammar(new DictationGrammar());
                        rec.InitialSilenceTimeout = TimeSpan.FromSeconds(5);
                        rec.BabbleTimeout = TimeSpan.FromSeconds(4);
                        rec.EndSilenceTimeout = TimeSpan.FromSeconds(0.9);
                        RecognitionResult rr = rec.Recognize(TimeSpan.FromSeconds(9));
                        if (rr != null) heard = rr.Text.Trim();
                        else err = "没听清，再说一次？";
                    }
                }
                catch (Exception ex)
                {
                    err = "麦克风用不了：" + ex.Message + "（系统里得有麦克风和中文语音识别）";
                }
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        recognizing = false;
                        btnMic.Enabled = true;
                        btnMic.Text = "说话";
                        if (heard.Length > 0)
                        {
                            input.Text = input.Text.Trim().Length > 0 ? (input.Text + heard) : heard;
                            UpdateInputHint();
                            input.Focus();
                            input.SelectionStart = input.Text.Length;
                            caption.StatusText = "听到了：" + heard;
                        }
                        else caption.StatusText = err;
                        caption.Invalidate();
                    });
                }
                catch { }
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
            if (text.Length == 0 && attachments.Count == 0) return;
            input.Text = "";
            List<string> paths = new List<string>();
            List<string> names = new List<string>();
            foreach (AttachItem it in attachments) { paths.Add(it.Path); names.Add(it.Name); }
            string filesLabel = names.Count > 0 ? string.Join("、", names.ToArray()) : "";
            chatView.Add(true, text.Length > 0 ? text : "（看看这些附件）", filesLabel);
            attachments.Clear();
            RebuildAttachChips();
            LayoutBottom();
            UpdateInputHint();
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
                    reply = api.Chat(text.Length > 0 ? text : "看看这些附件", paths.Count > 0 ? paths : null, out stats, out trace);
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
                        SpeakReply(reply);
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
        public void OpenPlugins()
        {
            try
            {
                using (PluginsForm f = new PluginsForm(api))
                {
                    f.ShowDialog(this);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "打开插件失败：" + ex.Message, "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
    class SettingsForm : Form
    {
        readonly ApiClient api;
        readonly string repoRoot;
        TextBox txtUrl, txtPort, txtBase, txtModel, txtKey;
        ComboBox cmbTier, cmbSandbox;
        TextBox txtWhitelist, txtQQUrl, txtQQToken;
        CheckBox chkMemory, chkShowKey;
        Button btnQQFind, btnQQLink, btnQQUnlink, btnAdd, btnDel;
        FlatBtn btnApplyKey;
        Label lblQQStatus;
        Panel headerPanel, contentPanel, footerPanel;
        FlatBtn btnSave, btnCancel, btnClose, btnConsole, btnPersona, btnVoiceNav, btnFeatureNav, btnRefreshStats, btnTestModel;
        FlatBtn btnTestProv, btnSpeakTest;
        TextBox txtPersona;
        FlatBtn btnResetPersona;
        Label lblProviderHint;
        CheckBox chkVoice;
        ComboBox cmbVoice;
        TrackBar trkRate;
        Label lblRate;
        CheckBox chkTentacle, chkSubagent, chkSpeakFeature, chkVisionFeature, chkEventsFeature;
        FlatBtn btnCheckUpdate;
        Label lblUpdate;
        Label lblStatus, lblTestResult;
        ComboBox cmbRouteMode;
        TextBox txtRouteOrder, txtMaxSteps, txtTopK, txtMaxHistory;
        CheckBox chkEscalate, chkAllowCommand;
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
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(Dpi.X(660), Dpi.X(700));
            MinimumSize = new Size(Dpi.X(560), Dpi.X(460));
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Bg;
            Font = Theme.Ui(9.5f, false);
            try
            {
                string ico = Path.Combine(Application.StartupPath, "icon.ico");
                if (File.Exists(ico)) Icon = new Icon(ico, 32, 32);
            }
            catch { }

            // 自绘标题栏（和主窗口一个观感），下面放可滚动内容，底部固定保存/取消
            headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = Dpi.X(46);
            headerPanel.BackColor = Theme.Paper;
            headerPanel.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f))
                    e.Graphics.DrawLine(p, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
            };
            headerPanel.MouseDown += DragDialog;
            Controls.Add(headerPanel);

            Label title = new Label();
            title.Text = "设置";
            title.Font = Theme.Ui(11.5f, true);
            title.ForeColor = Theme.Text;
            title.AutoSize = false;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.SetBounds(Dpi.X(18), 0, Dpi.X(220), Dpi.X(46));
            title.MouseDown += DragDialog;
            headerPanel.Controls.Add(title);

            btnClose = new FlatBtn("×", Theme.Paper, Theme.Dim);
            btnClose.Font = Theme.Ui(13f, false);
            btnClose.Click += delegate { Close(); };
            headerPanel.Controls.Add(btnClose);

            // 中控台：跳到设置页最下面的运行状态 + 选路 + 记忆参数
            btnConsole = new FlatBtn("中控台", Color.FromArgb(232, 243, 252), Theme.AccentDeep);
            btnConsole.Font = Theme.Ui(8.5f, true);
            btnConsole.Click += delegate { ScrollToConsole(); };
            headerPanel.Controls.Add(btnConsole);

            btnPersona = new FlatBtn("人格", Color.FromArgb(232, 243, 252), Theme.AccentDeep);
            btnPersona.Font = Theme.Ui(8.5f, true);
            btnPersona.Click += delegate { ScrollToPersona(); };
            headerPanel.Controls.Add(btnPersona);

            btnVoiceNav = new FlatBtn("语音", Color.FromArgb(232, 243, 252), Theme.AccentDeep);
            btnVoiceNav.Font = Theme.Ui(8.5f, true);
            btnVoiceNav.Click += delegate { ScrollToVoice(); };
            headerPanel.Controls.Add(btnVoiceNav);

            btnFeatureNav = new FlatBtn("功能", Color.FromArgb(232, 243, 252), Theme.AccentDeep);
            btnFeatureNav.Font = Theme.Ui(8.5f, true);
            btnFeatureNav.Click += delegate { ScrollToFeatures(); };
            headerPanel.Controls.Add(btnFeatureNav);

            footerPanel = new Panel();
            footerPanel.Dock = DockStyle.Bottom;
            footerPanel.Height = Dpi.X(58);
            footerPanel.BackColor = Theme.Paper;
            footerPanel.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f)) e.Graphics.DrawLine(p, 0, 0, footerPanel.Width, 0);
            };
            Controls.Add(footerPanel);

            btnSave = new FlatBtn("保存", Theme.Accent, Color.White);
            btnSave.AccessibleName = "btnSave";
            btnSave.Click += delegate { Save(); };
            footerPanel.Controls.Add(btnSave);

            btnCancel = new FlatBtn("取消", Color.White, Theme.AccentDeep);
            btnCancel.NormalBorder = Theme.Border;
            btnCancel.AccessibleName = "btnCancel";
            btnCancel.Click += delegate { Close(); };
            footerPanel.Controls.Add(btnCancel);

            contentPanel = new Panel();
            contentPanel.Dock = DockStyle.Fill;
            contentPanel.AutoScroll = true;
            contentPanel.BackColor = Theme.Bg;
            Controls.Add(contentPanel);
            contentPanel.BringToFront();

            BuildUi();
            contentPanel.AutoScrollMinSize = new Size(0, Dpi.X(2040));
            LayoutChrome();
            LoadConfig();
            ApplyRound();
            Resize += delegate { LayoutChrome(); ApplyRound(); };
            // 截图/验收用：JQ_CFG_SCROLL=1 滚到中控台，=2 滚到人格
            if (Environment.GetEnvironmentVariable("JQ_CFG_SCROLL") == "1")
                Shown += delegate { ScrollToConsole(); };
            if (Environment.GetEnvironmentVariable("JQ_CFG_SCROLL") == "2")
                Shown += delegate { ScrollToPersona(); };
            if (Environment.GetEnvironmentVariable("JQ_CFG_SCROLL") == "3")
                Shown += delegate { ScrollToVoice(); };
        }

        void LayoutChrome()
        {
            if (headerPanel == null) return;
            if (btnClose != null) btnClose.SetBounds(headerPanel.Width - Dpi.X(42), Dpi.X(8), Dpi.X(30), Dpi.X(30));
            if (btnConsole != null)
            {
                btnConsole.SetBounds(headerPanel.Width - Dpi.X(42) - Dpi.X(92), Dpi.X(9), Dpi.X(84), Dpi.X(28));
                if (btnPersona != null)
                {
                    btnPersona.SetBounds(btnConsole.Left - Dpi.X(6) - Dpi.X(64), Dpi.X(9), Dpi.X(64), Dpi.X(28));
                    if (btnVoiceNav != null) btnVoiceNav.SetBounds(btnPersona.Left - Dpi.X(6) - Dpi.X(64), Dpi.X(9), Dpi.X(64), Dpi.X(28));
                    if (btnFeatureNav != null) btnFeatureNav.SetBounds(btnVoiceNav.Left - Dpi.X(6) - Dpi.X(64), Dpi.X(9), Dpi.X(64), Dpi.X(28));
                }
            }
            if (btnSave != null)
            {
                btnSave.SetBounds(footerPanel.Width - Dpi.X(216), Dpi.X(11), Dpi.X(96), Dpi.X(36));
                btnCancel.SetBounds(footerPanel.Width - Dpi.X(112), Dpi.X(11), Dpi.X(96), Dpi.X(36));
            }
        }

        void DragDialog(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
        }

        void ApplyRound()
        {
            try
            {
                int pref = 2;
                if (Native.DwmSetWindowAttribute(Handle, 33, ref pref, 4) == 0) { Region = null; return; }
            }
            catch { }
            try
            {
                using (GraphicsPath gp = Theme.Round(new Rectangle(0, 0, Width, Height), Dpi.X(14)))
                    Region = new Region(gp);
            }
            catch { }
        }

        void BuildUi()
        {
            Section("服务", 14, 12);
            Cap("服务地址", 14, 42);
            txtUrl = Box(14, 62, 356);
            txtUrl.AccessibleName = "cfgUrl";
            Cap("端口", 384, 42);
            txtPort = Box(384, 62, 88);
            txtPort.AccessibleName = "cfgPort";
            Hint("服务地址一般不用改；改端口后要重启服务才生效。", 14, 94);

            Section("模型提供方", 14, 130);
            btnTestProv = SmallBtn("测试连接", 284, 124, 88, false);
            btnTestProv.Click += delegate { TestProvider(); };
            btnApplyKey = SmallBtn("申请密钥", 376, 124, 88, true);
            btnApplyKey.Click += delegate { OpenApplyUrl(); };
            btnAdd = SmallBtn("新增", 470, 124, 70, false);
            btnAdd.Click += delegate { AddProvider(); };
            btnDel = SmallBtn("删除", 546, 124, 70, false);
            btnDel.Click += delegate { DelProvider(); };

            list = new ListView();
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HideSelection = false;
            list.BorderStyle = BorderStyle.FixedSingle;
            list.BackColor = Color.White;
            list.Font = Theme.Ui(9f, false);
            list.SetBounds(Dpi.X(14), Dpi.X(162), Dpi.X(596), Dpi.X(148));
            list.Columns.Add("名字", Dpi.X(110));
            list.Columns.Add("状态", Dpi.X(56));
            list.Columns.Add("档位", Dpi.X(56));
            list.Columns.Add("模型", Dpi.X(120));
            list.Columns.Add("base", Dpi.X(254));
            list.AccessibleName = "cfgProviders";
            list.SelectedIndexChanged += delegate
            {
                if (list.SelectedIndices.Count > 0)
                {
                    CommitCurrent(list.SelectedIndices[0]);
                    SelectProvider(list.SelectedIndices[0]);
                }
            };
            contentPanel.Controls.Add(list);
            lblProviderHint = new Label();
            lblProviderHint.AutoSize = false;
            lblProviderHint.Font = Theme.Ui(8.5f, false);
            lblProviderHint.ForeColor = Theme.Dim;
            lblProviderHint.SetBounds(Dpi.X(14), Dpi.X(314), Dpi.X(596), Dpi.X(40));
            lblProviderHint.Text = "新手：选一家「未填」的 → 点「申请密钥」去拿 key → 粘到下面「密钥」→ 保存 → 关掉窗口重开就能用。";
            contentPanel.Controls.Add(lblProviderHint);

            Section("选中的提供方", 14, 352);
            Cap("base", 14, 382);
            txtBase = Box(14, 402, 596);
            txtBase.AccessibleName = "cfgBase";
            Cap("模型", 14, 436);
            txtModel = Box(14, 456, 300);
            txtModel.AccessibleName = "cfgModel";
            Cap("密钥", 326, 436);
            txtKey = Box(326, 456, 200);
            txtKey.PasswordChar = '*';
            txtKey.AccessibleName = "cfgKey";
            chkShowKey = new CheckBox();
            chkShowKey.Text = "显示";
            chkShowKey.Font = Theme.Ui(9f, false);
            chkShowKey.ForeColor = Theme.Dim;
            chkShowKey.SetBounds(Dpi.X(536), Dpi.X(459), Dpi.X(70), Dpi.X(24));
            chkShowKey.CheckedChanged += delegate { txtKey.PasswordChar = chkShowKey.Checked ? '\0' : '*'; };
            contentPanel.Controls.Add(chkShowKey);
            Hint("密钥显示为掩码；不改就沿用原来的。", 326, 488);

            Cap("档位", 14, 512);
            cmbTier = new ComboBox();
            cmbTier.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbTier.Font = Theme.Ui(9.5f, false);
            cmbTier.SetBounds(Dpi.X(14), Dpi.X(532), Dpi.X(140), Dpi.X(26));
            cmbTier.Items.Add("free");
            cmbTier.Items.Add("local");
            cmbTier.Items.Add("cloud");
            cmbTier.AccessibleName = "cfgTier";
            contentPanel.Controls.Add(cmbTier);

            Cap("沙盒档位", 184, 512);
            cmbSandbox = new ComboBox();
            cmbSandbox.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbSandbox.Font = Theme.Ui(9.5f, false);
            cmbSandbox.SetBounds(Dpi.X(184), Dpi.X(532), Dpi.X(130), Dpi.X(26));
            cmbSandbox.Items.Add("none");
            cmbSandbox.Items.Add("process");
            cmbSandbox.Items.Add("docker");
            cmbSandbox.AccessibleName = "cfgSandbox";
            contentPanel.Controls.Add(cmbSandbox);

            Cap("命令白名单（逗号分隔）", 14, 570);
            txtWhitelist = Box(14, 590, 596);
            txtWhitelist.AccessibleName = "cfgWhitelist";

            chkMemory = new CheckBox();
            chkMemory.Text = "自动记记忆（autoCapture）";
            chkMemory.Font = Theme.Ui(9f, false);
            chkMemory.ForeColor = Theme.Text;
            chkMemory.SetBounds(Dpi.X(14), Dpi.X(626), Dpi.X(300), Dpi.X(24));
            chkMemory.AccessibleName = "cfgMemory";
            contentPanel.Controls.Add(chkMemory);

            Section("QQ 一键连接（可选，默认关）", 14, 662);
            btnQQFind = SmallBtn("自动找 QQ 桥接", 14, 690, 150, true);
            btnQQFind.AccessibleName = "cfgQQFind";
            btnQQFind.Click += delegate { QQFind(); };

            lblQQStatus = new Label();
            lblQQStatus.AutoSize = false;
            lblQQStatus.Text = "QQ：未检测";
            lblQQStatus.ForeColor = Theme.Dim;
            lblQQStatus.Font = Theme.Ui(9f, false);
            lblQQStatus.SetBounds(Dpi.X(176), Dpi.X(694), Dpi.X(270), Dpi.X(26));
            contentPanel.Controls.Add(lblQQStatus);

            btnQQLink = SmallBtn("连接", 452, 690, 70, false);
            btnQQLink.AccessibleName = "cfgQQLink";
            btnQQLink.Enabled = false;
            btnQQLink.Click += delegate { QQConnect(); };

            btnQQUnlink = SmallBtn("断开", 530, 690, 70, false);
            btnQQUnlink.AccessibleName = "cfgQQUnlink";
            btnQQUnlink.Enabled = false;
            btnQQUnlink.Click += delegate { QQDisconnect(); };

            Cap("网关地址", 14, 730);
            txtQQUrl = Box(14, 750, 380);
            txtQQUrl.AccessibleName = "cfgQQUrl";
            Cap("令牌", 408, 730);
            txtQQToken = Box(408, 750, 202);
            txtQQToken.PasswordChar = '*';
            txtQQToken.AccessibleName = "cfgQQToken";

            Hint("没接网关时不用管它；网桥收到消息后调本机服务，再把回复发回 QQ。", 14, 784);

            // ---------- 中控台（运行状态 + 选路 + 记忆参数） ----------
            Section("中控台", 14, 872);
            lblStatus = new Label();
            lblStatus.AutoSize = false;
            lblStatus.Font = Theme.Ui(9f, false);
            lblStatus.ForeColor = Theme.Text;
            lblStatus.Text = "点「刷新状态」看这台机器现在的情况。";
            lblStatus.SetBounds(Dpi.X(14), Dpi.X(902), Dpi.X(596), Dpi.X(44));
            contentPanel.Controls.Add(lblStatus);

            btnRefreshStats = SmallBtn("刷新状态", 14, 952, 92, true);
            btnRefreshStats.Click += delegate { RefreshStats(); };
            btnTestModel = SmallBtn("测当前模型", 112, 952, 100, false);
            btnTestModel.Click += delegate { TestCurrentModel(); };

            lblTestResult = new Label();
            lblTestResult.AutoSize = false;
            lblTestResult.Font = Theme.Ui(8.5f, false);
            lblTestResult.ForeColor = Theme.Dim;
            lblTestResult.Text = "";
            lblTestResult.SetBounds(Dpi.X(224), Dpi.X(958), Dpi.X(386), Dpi.X(26));
            contentPanel.Controls.Add(lblTestResult);

            Cap("选路方式", 14, 996);
            cmbRouteMode = new ComboBox();
            cmbRouteMode.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbRouteMode.Font = Theme.Ui(9.5f, false);
            cmbRouteMode.SetBounds(Dpi.X(14), Dpi.X(1016), Dpi.X(132), Dpi.X(26));
            cmbRouteMode.Items.Add("cheap-first");
            cmbRouteMode.Items.Add("fixed");
            cmbRouteMode.Items.Add("cloud-first");
            contentPanel.Controls.Add(cmbRouteMode);

            Cap("最大步数", 158, 996);
            txtMaxSteps = Box(158, 1016, 60);

            chkEscalate = new CheckBox();
            chkEscalate.Text = "拿不准时升到更贵的模型";
            chkEscalate.Font = Theme.Ui(9f, false);
            chkEscalate.ForeColor = Theme.Text;
            chkEscalate.SetBounds(Dpi.X(236), Dpi.X(1020), Dpi.X(240), Dpi.X(24));
            contentPanel.Controls.Add(chkEscalate);

            Cap("提供方顺序（逗号分隔；留空 = 按上面列表顺序）", 14, 1056);
            txtRouteOrder = Box(14, 1076, 596);

            Cap("召回条数", 14, 1118);
            txtTopK = Box(14, 1138, 80);
            Cap("历史轮数", 120, 1118);
            txtMaxHistory = Box(120, 1138, 80);

            chkAllowCommand = new CheckBox();
            chkAllowCommand.Text = "允许跑命令（只跑白名单里的）";
            chkAllowCommand.Font = Theme.Ui(9f, false);
            chkAllowCommand.ForeColor = Theme.Text;
            chkAllowCommand.SetBounds(Dpi.X(216), Dpi.X(1142), Dpi.X(280), Dpi.X(24));
            contentPanel.Controls.Add(chkAllowCommand);

            Hint("改完点最下面「保存」；端口、模型、沙盒这些要重启服务才生效。", 14, 1178);

            // ---------- 人格 ----------
            Section("人格", 14, 1218);
            Hint("她是谁、怎么说话，全写在这段里（会作为 system 提示词）。留空 = 用内置默认人格。", 14, 1248);
            txtPersona = new TextBox();
            txtPersona.Multiline = true;
            txtPersona.ScrollBars = ScrollBars.Vertical;
            txtPersona.BorderStyle = BorderStyle.FixedSingle;
            txtPersona.BackColor = Color.White;
            txtPersona.Font = Theme.Ui(9.5f, false);
            txtPersona.SetBounds(Dpi.X(14), Dpi.X(1278), Dpi.X(596), Dpi.X(120));
            txtPersona.AccessibleName = "cfgPersona";
            contentPanel.Controls.Add(txtPersona);

            btnResetPersona = SmallBtn("恢复默认", 14, 1408, 92, false);
            btnResetPersona.Click += delegate
            {
                txtPersona.Text = "";
                lblTestResult.Text = "已清空：保存后就用内置默认人格";
                lblTestResult.ForeColor = Theme.Dim;
            };
            Label ph = new Label();
            ph.AutoSize = false;
            ph.Font = Theme.Ui(8.5f, false);
            ph.ForeColor = Theme.Dim;
            ph.Text = "内置默认：叫鲸倩、短句口语、不列清单、不说自己是什么模型、不知道就说不确定。";
            ph.SetBounds(Dpi.X(114), Dpi.X(1412), Dpi.X(500), Dpi.X(24));
            contentPanel.Controls.Add(ph);

            // ---------- 语音 ----------
            Section("语音", 14, 1470);
            Hint("朗读她用系统自带的声音，不联网、不要 key；麦克风听写也是本机识别（中文），说完一段自动断句。", 14, 1498);

            chkVoice = new CheckBox();
            chkVoice.Text = "朗读她的回复";
            chkVoice.Font = Theme.Ui(9.5f, false);
            chkVoice.ForeColor = Theme.Text;
            chkVoice.SetBounds(Dpi.X(14), Dpi.X(1540), Dpi.X(260), Dpi.X(24));
            contentPanel.Controls.Add(chkVoice);

            Cap("声音", 14, 1576);
            cmbVoice = new ComboBox();
            cmbVoice.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbVoice.Font = Theme.Ui(9.5f, false);
            cmbVoice.SetBounds(Dpi.X(14), Dpi.X(1596), Dpi.X(330), Dpi.X(26));
            contentPanel.Controls.Add(cmbVoice);

            btnSpeakTest = SmallBtn("试听", 356, 1596, 70, false);
            btnSpeakTest.Click += delegate { PreviewVoice(); };

            Cap("语速", 440, 1576);
            trkRate = new TrackBar();
            trkRate.Minimum = -10;
            trkRate.Maximum = 10;
            trkRate.TickStyle = TickStyle.None;
            trkRate.SetBounds(Dpi.X(440), Dpi.X(1594), Dpi.X(150), Dpi.X(28));
            trkRate.ValueChanged += delegate { if (lblRate != null) lblRate.Text = trkRate.Value.ToString(); };
            contentPanel.Controls.Add(trkRate);
            lblRate = new Label();
            lblRate.AutoSize = false;
            lblRate.Font = Theme.Ui(9f, false);
            lblRate.ForeColor = Theme.Dim;
            lblRate.SetBounds(Dpi.X(596), Dpi.X(1600), Dpi.X(30), Dpi.X(22));
            lblRate.Text = "0";
            contentPanel.Controls.Add(lblRate);

            Hint("聊天框右边「说话」按钮：点一下，说完停一下，识别结果会填进输入框（先看一眼再发送）。", 14, 1640);

            // ---------- 功能开关（从私有版迁过来的几个能力） ----------
            Section("功能开关", 14, 1700);
            Hint("关掉哪项，她工具箱里就没有那个工具；改了要保存并重启服务。", 14, 1728);

            chkTentacle = FeatureCheck("触手：看屏幕、点按打字、操作受控浏览器", 14, 1764);
            chkSubagent = FeatureCheck("子智能体：能派一个独立分身去干活", 14, 1792);
            chkSpeakFeature = FeatureCheck("开口说话：她可以主动念一句（系统语音）", 14, 1820);
            chkVisionFeature = FeatureCheck("看图：拖进来的图片交给视觉模型", 14, 1848);
            chkEventsFeature = FeatureCheck("事件时间轴：把零散的话串成事", 14, 1876);

            Hint("这些能力原来在私有版里，现在搬到开源版；触手脚本在 tools/tentacle/，动作脚本会先画圈再动手。", 14, 1916);

            btnCheckUpdate = SmallBtn("检查更新", 14, 1952, 96, false);
            btnCheckUpdate.Click += delegate { CheckUpdate(); };
            lblUpdate = new Label();
            lblUpdate.AutoSize = false;
            lblUpdate.Font = Theme.Ui(8.5f, false);
            lblUpdate.ForeColor = Theme.Dim;
            lblUpdate.SetBounds(Dpi.X(122), Dpi.X(1958), Dpi.X(500), Dpi.X(24));
            lblUpdate.Text = "点一下看看有没有新版本（读 config.update.manifestUrl）";
            contentPanel.Controls.Add(lblUpdate);
        }

        void CheckUpdate()
        {
            if (lblUpdate == null) return;
            lblUpdate.ForeColor = Theme.Dim;
            lblUpdate.Text = "正在查…";
            Application.DoEvents();
            try
            {
                Dictionary<string, object> r = api.Get("/api/update/check", 20000);
                if (!r.ContainsKey("ok") || !Convert.ToBoolean(r["ok"]))
                {
                    lblUpdate.Text = "查不了：" + (r.ContainsKey("error") ? Convert.ToString(r["error"]) : "未知原因");
                    lblUpdate.ForeColor = Theme.Warn;
                    return;
                }
                string cur = r.ContainsKey("current") ? Convert.ToString(r["current"]) : "?";
                string latest = r.ContainsKey("latest") ? Convert.ToString(r["latest"]) : "?";
                bool newer = r.ContainsKey("newer") && Convert.ToBoolean(r["newer"]);
                string url = r.ContainsKey("url") ? Convert.ToString(r["url"]) : "";
                if (!newer)
                {
                    lblUpdate.Text = "已经是最新（" + cur + "）";
                    lblUpdate.ForeColor = Color.FromArgb(60, 150, 100);
                    return;
                }
                lblUpdate.Text = "有新版本 " + latest + "（当前 " + cur + "）" + (url.Length > 0 ? "，已打开下载页" : "");
                lblUpdate.ForeColor = Theme.AccentDeep;
                if (url.Length > 0) Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                lblUpdate.Text = "检查失败：" + ex.Message;
                lblUpdate.ForeColor = Theme.Warn;
            }
        }

        CheckBox FeatureCheck(string text, int x, int y)
        {
            CheckBox c = new CheckBox();
            c.Text = text;
            c.Font = Theme.Ui(9.5f, false);
            c.ForeColor = Theme.Text;
            c.SetBounds(Dpi.X(x), Dpi.X(y), Dpi.X(560), Dpi.X(24));
            contentPanel.Controls.Add(c);
            return c;
        }

        void ScrollToFeatures()
        {
            if (contentPanel == null || chkTentacle == null) return;
            contentPanel.AutoScrollPosition = new Point(0, chkTentacle.Top);
            contentPanel.Invalidate();
        }

        void PreviewVoice()
        {
            try
            {
                string name = cmbVoice != null && cmbVoice.SelectedItem != null ? cmbVoice.SelectedItem.ToString().Split('|')[0].Trim() : "";
                SpeechSynthesizer s = Speech.Make(name, trkRate != null ? trkRate.Value : 0);
                s.SpeakAsyncCancelAll();
                s.Speak("你好呀，我是鲸倩。这句话是用来试声音的。");
                s.SpeakCompleted += delegate { try { s.Dispose(); } catch { } };
            }
            catch (Exception ex)
            {
                lblTestResult.Text = "试听失败：" + ex.Message;
                lblTestResult.ForeColor = Theme.Warn;
            }
        }

        void ScrollToVoice()
        {
            if (contentPanel == null || chkVoice == null) return;
            contentPanel.AutoScrollPosition = new Point(0, chkVoice.Top);
            contentPanel.Invalidate();
        }

        // 中控台：把运行状态拉下来拼成两行字（没连上就直说，不编）
        void RefreshStats()
        {
            if (lblStatus == null) return;
            try
            {
                Dictionary<string, object> sc = api.Get("/api/selfcheck", 4000);
                Dictionary<string, object> st = api.Get("/api/stats", 5000);
                object o;
                int radarNew = 0;
                try
                {
                    Dictionary<string, object> rd = api.Get("/api/radar", 3000);
                    if (rd.TryGetValue("new", out o) && o is object[]) radarNew = ((object[])o).Length;
                }
                catch { }

                string port = "?";
                long uptime = 0;
                int provReady = 0, provTotal = 0;
                if (st.TryGetValue("server", out o) && o is Dictionary<string, object>)
                {
                    Dictionary<string, object> sv = (Dictionary<string, object>)o;
                    if (sv.ContainsKey("port")) port = Convert.ToString(sv["port"]);
                    if (sv.ContainsKey("uptime_s")) uptime = Convert.ToInt64(sv["uptime_s"]);
                }
                if (st.TryGetValue("providers", out o) && o is object[])
                {
                    foreach (object x in (object[])o)
                    {
                        Dictionary<string, object> p = x as Dictionary<string, object>;
                        if (p == null) continue;
                        provTotal++;
                        if (p.ContainsKey("ready") && Convert.ToBoolean(p["ready"])) provReady++;
                    }
                }
                long calls = 0, toks = 0;
                if (st.TryGetValue("ledger_today", out o) && o is Dictionary<string, object>)
                {
                    Dictionary<string, object> lg = (Dictionary<string, object>)o;
                    if (lg.ContainsKey("calls")) calls = Convert.ToInt64(lg["calls"]);
                    long pt = lg.ContainsKey("prompt_tokens") ? Convert.ToInt64(lg["prompt_tokens"]) : 0;
                    long ct = lg.ContainsKey("completion_tokens") ? Convert.ToInt64(lg["completion_tokens"]) : 0;
                    toks = pt + ct;
                }
                long memCount = 0;
                if (st.TryGetValue("memory", out o) && o is Dictionary<string, object>)
                {
                    Dictionary<string, object> m = (Dictionary<string, object>)o;
                    if (m.ContainsKey("count")) memCount = Convert.ToInt64(m["count"]);
                }

                string up = uptime >= 3600 ? (uptime / 3600) + " 小时 " + ((uptime % 3600) / 60) + " 分" : (uptime / 60) + " 分钟";
                lblStatus.Text = "服务 127.0.0.1:" + port + " · 已跑 " + up + " · 模型 " + provReady + "/" + provTotal + " 就绪\n"
                    + "今日 " + calls + " 次 · " + (toks / 1000.0).ToString("0.#") + "k tokens · 记忆 " + memCount + " 条 · 雷达待处理 " + radarNew + " 个";
                lblStatus.ForeColor = Theme.Text;
            }
            catch (Exception ex)
            {
                lblStatus.Text = "连不上服务（" + api.BaseUrl + "）：" + ex.Message;
                lblStatus.ForeColor = Theme.Warn;
            }
        }

        void TestCurrentModel()
        {
            if (lblTestResult == null) return;
            if (current < 0 || current >= providers.Count)
            {
                lblTestResult.Text = "先在上面选中一家模型";
                lblTestResult.ForeColor = Theme.Warn;
                return;
            }
            CommitCurrent(current);
            Dictionary<string, object> p = providers[current];
            Dictionary<string, object> body = new Dictionary<string, object>();
            Dictionary<string, object> pr = new Dictionary<string, object>();
            pr["name"] = Get(p, "name");
            pr["base"] = Get(p, "base");
            pr["model"] = Get(p, "model");
            pr["key"] = txtKey.Text;
            body["provider"] = pr;
            btnTestModel.Enabled = false;
            lblTestResult.ForeColor = Theme.Dim;
            lblTestResult.Text = "正在测…";
            Application.DoEvents();
            try
            {
                Dictionary<string, object> r = api.Post("/api/config/test", body, 30000);
                bool okNow = r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]);
                string ms = r.ContainsKey("ms") ? Convert.ToString(r["ms"]) + " ms" : "";
                if (okNow)
                {
                    lblTestResult.Text = "通了（" + ms + "）";
                    lblTestResult.ForeColor = Color.FromArgb(60, 150, 100);
                }
                else
                {
                    string err = r.ContainsKey("error") ? Convert.ToString(r["error"])
                        : ("HTTP " + Convert.ToString(r.ContainsKey("status") ? r["status"] : "?"));
                    lblTestResult.Text = "没通：" + err;
                    lblTestResult.ForeColor = Theme.Warn;
                }
            }
            catch (Exception ex)
            {
                lblTestResult.Text = "测失败：" + ex.Message;
                lblTestResult.ForeColor = Theme.Warn;
            }
            finally { btnTestModel.Enabled = true; }
        }

        void ScrollToConsole()
        {
            if (contentPanel == null || lblStatus == null) return;
            contentPanel.AutoScrollPosition = new Point(0, contentPanel.AutoScrollMinSize.Height);
            contentPanel.Invalidate();
        }

        void ScrollToPersona()
        {
            if (contentPanel == null || txtPersona == null) return;
            contentPanel.AutoScrollPosition = new Point(0, txtPersona.Top);
            contentPanel.Invalidate();
        }

        Label Section(string text, int x, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.Font = Theme.Ui(10.5f, true);
            l.ForeColor = Theme.AccentDeep;
            l.Location = new Point(Dpi.X(x), Dpi.X(y));
            contentPanel.Controls.Add(l);
            return l;
        }

        Label Cap(string text, int x, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.Font = Theme.Ui(9f, false);
            l.ForeColor = Theme.Dim;
            l.Location = new Point(Dpi.X(x), Dpi.X(y));
            contentPanel.Controls.Add(l);
            return l;
        }

        TextBox Box(int x, int y, int w)
        {
            TextBox b = new TextBox();
            b.SetBounds(Dpi.X(x), Dpi.X(y), Dpi.X(w), Dpi.X(26));
            b.BorderStyle = BorderStyle.FixedSingle;
            b.BackColor = Color.White;
            b.Font = Theme.Ui(9.5f, false);
            contentPanel.Controls.Add(b);
            return b;
        }

        Label Hint(string text, int x, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = false;
            l.Font = Theme.Ui(8.5f, false);
            l.ForeColor = Theme.Dim;
            l.SetBounds(Dpi.X(x), Dpi.X(y), Dpi.X(596), Dpi.X(38));
            contentPanel.Controls.Add(l);
            return l;
        }

        FlatBtn SmallBtn(string text, int x, int y, int w, bool primary)
        {
            FlatBtn b = new FlatBtn(text, primary ? Theme.Accent : Color.White, primary ? Color.White : Theme.AccentDeep);
            if (!primary) b.NormalBorder = Theme.Border;
            b.Font = Theme.Ui(8.5f, true);
            b.SetBounds(Dpi.X(x), Dpi.X(y), Dpi.X(w), Dpi.X(30));
            contentPanel.Controls.Add(b);
            return b;
        }

        void CommitCurrent(int newIndex)
        {
            if (current < 0 || current >= providers.Count) return;
            providers[current]["base"] = txtBase.Text.Trim();
            providers[current]["model"] = txtModel.Text.Trim();
            providers[current]["key"] = txtKey.Text;
            providers[current]["tier"] = Convert.ToString(cmbTier.SelectedItem ?? "cloud");
            if (list.Items.Count > current)
                list.Items[current].SubItems[2].Text = Get(providers[current], "model");
        }

        void AddProvider()
        {
            CommitCurrent(current);
            Dictionary<string, object> p = new Dictionary<string, object>();
            p["name"] = "新模型" + (providers.Count + 1);
            p["tier"] = "cloud";
            p["base"] = "";
            p["model"] = "";
            p["key"] = "";
            p["price_in"] = 0;
            p["price_out"] = 0;
            providers.Add(p);
            RefreshList();
            current = providers.Count - 1;
            list.Items[current].Selected = true;
            list.Select();
            SelectProvider(current);
            contentPanel.ScrollControlIntoView(btnAdd);
        }

        void DelProvider()
        {
            if (current < 0 || current >= providers.Count) return;
            string name = Get(providers[current], "name");
            if (MessageBox.Show(this, "删掉提供方「" + name + "」？保存后才生效。", "鲸倩",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            providers.RemoveAt(current);
            current = -1;
            RefreshList();
            txtBase.Text = "";
            txtModel.Text = "";
            txtKey.Text = "";
            list.SelectedItems.Clear();
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
                bool allowCmd = true;
                if (cfg.TryGetValue("tools", out sub) && sub is Dictionary<string, object> && ((Dictionary<string, object>)sub).ContainsKey("allowCommand"))
                    allowCmd = Convert.ToBoolean(((Dictionary<string, object>)sub)["allowCommand"]);
                chkAllowCommand.Checked = allowCmd;

                // 选路（中控台）
                string routeMode = "cheap-first";
                string routeOrder = "";
                bool escalate = true;
                int maxSteps = 12;
                if (cfg.TryGetValue("route", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> rd = (Dictionary<string, object>)sub;
                    if (rd.ContainsKey("mode")) routeMode = Convert.ToString(rd["mode"]);
                    if (rd.ContainsKey("escalate")) escalate = Convert.ToBoolean(rd["escalate"]);
                    if (rd.ContainsKey("maxSteps")) maxSteps = Convert.ToInt32(rd["maxSteps"]);
                    object ord;
                    if (rd.TryGetValue("order", out ord) && ord is object[])
                    {
                        List<string> xs = new List<string>();
                        foreach (object o in (object[])ord) xs.Add(Convert.ToString(o));
                        routeOrder = string.Join(",", xs.ToArray());
                    }
                }
                cmbRouteMode.SelectedItem = (routeMode == "fixed" || routeMode == "cloud-first") ? routeMode : "cheap-first";
                txtRouteOrder.Text = routeOrder;
                chkEscalate.Checked = escalate;
                txtMaxSteps.Text = Convert.ToString(maxSteps);

                int topK = 5, maxHistory = 16;
                bool autoCap = true;
                if (cfg.TryGetValue("memory", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> md = (Dictionary<string, object>)sub;
                    if (md.ContainsKey("autoCapture")) autoCap = Convert.ToBoolean(md["autoCapture"]);
                    if (md.ContainsKey("topK")) topK = Convert.ToInt32(md["topK"]);
                    if (md.ContainsKey("maxHistory")) maxHistory = Convert.ToInt32(md["maxHistory"]);
                }
                chkMemory.Checked = autoCap;
                txtTopK.Text = Convert.ToString(topK);
                txtMaxHistory.Text = Convert.ToString(maxHistory);

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
                txtPersona.Text = cfg.ContainsKey("persona") ? Convert.ToString(cfg["persona"]) : "";
                // 语音：列出本机声音，选中配置里那家（没配就选中文声音）
                bool vOn = false;
                string vName = "";
                int vRate = 0;
                if (cfg.TryGetValue("voice", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> vo = (Dictionary<string, object>)sub;
                    vOn = vo.ContainsKey("enabled") && Convert.ToBoolean(vo["enabled"]);
                    vName = vo.ContainsKey("voice") ? Convert.ToString(vo["voice"]) : "";
                    vRate = vo.ContainsKey("rate") ? Convert.ToInt32(vo["rate"]) : 0;
                }
                chkVoice.Checked = vOn;
                try
                {
                    cmbVoice.Items.Clear();
                    string firstZh = "";
                    using (SpeechSynthesizer s = new SpeechSynthesizer())
                    {
                        foreach (InstalledVoice v in s.GetInstalledVoices())
                        {
                            if (!v.Enabled) continue;
                            string label = v.VoiceInfo.Name + " | " + v.VoiceInfo.Culture;
                            cmbVoice.Items.Add(label);
                            if (firstZh.Length == 0 && v.VoiceInfo.Culture != null && v.VoiceInfo.Culture.Name.StartsWith("zh")) firstZh = label;
                        }
                    }
                    string want = vName.Length > 0 ? vName : firstZh;
                    int sel = -1;
                    for (int i = 0; i < cmbVoice.Items.Count; i++)
                        if (cmbVoice.Items[i].ToString().StartsWith(want)) { sel = i; break; }
                    if (sel >= 0) cmbVoice.SelectedIndex = sel;
                    else if (cmbVoice.Items.Count > 0) cmbVoice.SelectedIndex = 0;
                }
                catch { }
                trkRate.Value = Math.Max(-10, Math.Min(10, vRate));
                if (lblRate != null) lblRate.Text = trkRate.Value.ToString();
                // 功能开关
                bool fTentacle = true, fSub = true, fSpk = true, fVis = true, fEv = true;
                if (cfg.TryGetValue("features", out sub) && sub is Dictionary<string, object>)
                {
                    Dictionary<string, object> fd = (Dictionary<string, object>)sub;
                    if (fd.ContainsKey("tentacle")) fTentacle = Convert.ToBoolean(fd["tentacle"]);
                    if (fd.ContainsKey("subagent")) fSub = Convert.ToBoolean(fd["subagent"]);
                    if (fd.ContainsKey("speak")) fSpk = Convert.ToBoolean(fd["speak"]);
                    if (fd.ContainsKey("vision")) fVis = Convert.ToBoolean(fd["vision"]);
                    if (fd.ContainsKey("events")) fEv = Convert.ToBoolean(fd["events"]);
                }
                chkTentacle.Checked = fTentacle;
                chkSubagent.Checked = fSub;
                chkSpeakFeature.Checked = fSpk;
                chkVisionFeature.Checked = fVis;
                chkEventsFeature.Checked = fEv;
                RefreshStats();
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
                string key = Get(p, "key");
                bool local = Get(p, "tier") == "local";
                string state = (key.Length > 0 || local) ? "已填" : "未填";
                string[] row = new string[] {
                    Get(p, "name"), state, Get(p, "tier"), Get(p, "model"), Get(p, "base")
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
            cmbTier.SelectedItem = (tier == "local" || tier == "free") ? tier : "cloud";
            if (btnApplyKey != null)
            {
                string url = Get(p, "applyUrl");
                btnApplyKey.Enabled = url.Length > 0;
            }
        }

        // 新手最缺这一步：直接把人送到拿 key 的页面，别让他自己找
        void OpenApplyUrl()
        {
            if (current < 0 || current >= providers.Count) return;
            string url = Get(providers[current], "applyUrl");
            if (url.Length == 0) { lblTestResult.Text = "这家没配申请地址，去官网注册后把 key 粘到密钥里"; lblTestResult.ForeColor = Theme.Warn; return; }
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                lblTestResult.Text = "已打开申请页：注册 → 复制 key → 粘到下面「密钥」→ 保存";
                lblTestResult.ForeColor = Theme.Dim;
            }
            catch (Exception ex)
            {
                lblTestResult.Text = "打不开浏览器：" + ex.Message + "（手动访问 " + url + "）";
                lblTestResult.ForeColor = Theme.Warn;
            }
        }

        // 在设置页直接测当前这家能不能通（新手填完 key 最想确认这个）
        void TestProvider()
        {
            if (current < 0 || current >= providers.Count)
            {
                lblProviderHint.Text = "先在上面选一家。";
                lblProviderHint.ForeColor = Theme.Warn;
                return;
            }
            CommitCurrent(current);
            Dictionary<string, object> p = providers[current];
            Dictionary<string, object> pr = new Dictionary<string, object>();
            pr["name"] = Get(p, "name");
            pr["base"] = txtBase.Text.Trim();
            pr["model"] = txtModel.Text.Trim();
            pr["key"] = txtKey.Text;
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["provider"] = pr;
            btnTestProv.Enabled = false;
            lblProviderHint.ForeColor = Theme.Dim;
            lblProviderHint.Text = "正在测「" + Get(p, "name") + "」…";
            Application.DoEvents();
            try
            {
                Dictionary<string, object> r = api.Post("/api/config/test", body, 30000);
                bool okNow = r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]);
                string ms = r.ContainsKey("ms") ? Convert.ToString(r["ms"]) + " ms" : "";
                if (okNow)
                {
                    lblProviderHint.Text = "通了（" + ms + "）。点下面「保存」→ 关掉窗口重开就能用这家。";
                    lblProviderHint.ForeColor = Color.FromArgb(60, 150, 100);
                }
                else
                {
                    string err = r.ContainsKey("error") ? Convert.ToString(r["error"])
                        : ("HTTP " + Convert.ToString(r.ContainsKey("status") ? r["status"] : "?"));
                    lblProviderHint.Text = "没通：" + err + "（key 对不对、base 有没有抄错）";
                    lblProviderHint.ForeColor = Theme.Warn;
                }
            }
            catch (Exception ex)
            {
                lblProviderHint.Text = "测失败：" + ex.Message;
                lblProviderHint.ForeColor = Theme.Warn;
            }
            finally { btnTestProv.Enabled = true; }
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
                int portNum;
                if (!int.TryParse(txtPort.Text.Trim(), out portNum) || portNum < 1024 || portNum > 65535)
                {
                    MessageBox.Show(this, "端口要填 1024~65535 之间的数字（一般保持 7889 就行）。",
                        "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                if (current >= 0 && current < providers.Count)
                {
                    string nb = txtBase.Text.Trim(), nm = txtModel.Text.Trim();
                    if (nb.Length == 0 || nm.Length == 0)
                    {
                        MessageBox.Show(this, "选中的这家还没填「base」和「模型」。\n\n"
                            + "内置的几家都已经写好了，正常不用改；如果是自己新增的，把接口地址和模型名填上再保存。",
                            "鲸倩", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                }
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
                tb["allowCommand"] = chkAllowCommand.Checked;
                body["tools"] = tb;
                Dictionary<string, object> mb = new Dictionary<string, object>();
                mb["autoCapture"] = chkMemory.Checked;
                int tk, mh;
                if (int.TryParse(txtTopK.Text.Trim(), out tk) && tk > 0) mb["topK"] = tk;
                if (int.TryParse(txtMaxHistory.Text.Trim(), out mh) && mh >= 0) mb["maxHistory"] = mh;
                body["memory"] = mb;

                // 中控台：选路（顺序留空就用现在列表的顺序）
                Dictionary<string, object> rb = new Dictionary<string, object>();
                rb["mode"] = Convert.ToString(cmbRouteMode.SelectedItem ?? "cheap-first");
                rb["escalate"] = chkEscalate.Checked;
                int ms;
                if (int.TryParse(txtMaxSteps.Text.Trim(), out ms) && ms > 0) rb["maxSteps"] = ms;
                List<string> order = new List<string>();
                foreach (string x in txtRouteOrder.Text.Split(',')) { if (x.Trim().Length > 0) order.Add(x.Trim()); }
                if (order.Count == 0)
                {
                    foreach (Dictionary<string, object> p in providers) order.Add(Get(p, "name"));
                }
                rb["order"] = order;
                body["route"] = rb;
                body["persona"] = txtPersona.Text.Trim();
                Dictionary<string, object> vb = new Dictionary<string, object>();
                vb["enabled"] = chkVoice.Checked;
                vb["voice"] = (cmbVoice.SelectedItem != null) ? cmbVoice.SelectedItem.ToString().Split('|')[0].Trim() : "";
                vb["rate"] = trkRate.Value;
                body["voice"] = vb;
                Dictionary<string, object> fb = new Dictionary<string, object>();
                fb["tentacle"] = chkTentacle.Checked;
                fb["subagent"] = chkSubagent.Checked;
                fb["speak"] = chkSpeakFeature.Checked;
                fb["vision"] = chkVisionFeature.Checked;
                fb["events"] = chkEventsFeature.Checked;
                body["features"] = fb;
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
        Label searchHint;
        Label hint;
        ListView list;
        List<string> ids = new List<string>();
        List<string[]> rows = new List<string[]>();
        FlatBtn btnClose;

        public MemoryForm(ApiClient api)
        {
            this.api = api;
            Text = "记忆 · 鲸倩";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(Dpi.X(700), Dpi.X(560));
            MinimumSize = new Size(Dpi.X(520), Dpi.X(400));
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Bg;
            Font = Theme.Ui(9.5f, false);
            try { string ico = Path.Combine(Application.StartupPath, "icon.ico"); if (File.Exists(ico)) Icon = new Icon(ico); } catch { }

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = Dpi.X(46);
            header.BackColor = Theme.Paper;
            header.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border, 1f))
                    e.Graphics.DrawLine(p, 0, header.Height - 1, header.Width, header.Height - 1);
            };
            header.MouseDown += DragDialog;
            Controls.Add(header);

            Label title = new Label();
            title.Text = "记忆";
            title.Font = Theme.Ui(11.5f, true);
            title.ForeColor = Theme.Text;
            title.AutoSize = false;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.SetBounds(Dpi.X(18), 0, Dpi.X(200), Dpi.X(46));
            title.MouseDown += DragDialog;
            header.Controls.Add(title);

            btnClose = new FlatBtn("×", Theme.Paper, Theme.Dim);
            btnClose.Font = Theme.Ui(13f, false);
            btnClose.SetBounds(Dpi.X(700 - 42), Dpi.X(8), Dpi.X(30), Dpi.X(30));
            btnClose.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnClose.Click += delegate { Close(); };
            header.Controls.Add(btnClose);

            search = new TextBox();
            search.BorderStyle = BorderStyle.FixedSingle;
            search.Font = Theme.Ui(9.5f, false);
            search.BackColor = Color.White;
            search.SetBounds(Dpi.X(16), Dpi.X(66), Dpi.X(440), Dpi.X(28));
            search.AccessibleName = "memSearch";
            search.TextChanged += delegate { UpdateSearchHint(); };
            Controls.Add(search);

            searchHint = new Label();
            searchHint.AutoSize = false;
            searchHint.BackColor = Color.White;
            searchHint.ForeColor = Color.FromArgb(170, 184, 196);
            searchHint.Font = Theme.Ui(9f, false);
            searchHint.TextAlign = ContentAlignment.MiddleLeft;
            searchHint.Text = "搜点什么…（比如：房租、忌口、约定）";
            searchHint.SetBounds(Dpi.X(21), Dpi.X(68), Dpi.X(420), Dpi.X(24));
            searchHint.Cursor = Cursors.IBeam;
            searchHint.Click += delegate { search.Focus(); };
            Controls.Add(searchHint);
            searchHint.BringToFront();

            FlatBtn go = new FlatBtn("搜索", Theme.Accent, Color.White);
            go.Font = Theme.Ui(9f, true);
            go.AccessibleName = "memSearchBtn";
            go.SetBounds(Dpi.X(468), Dpi.X(66), Dpi.X(84), Dpi.X(28));
            go.Click += delegate { Reload(search.Text.Trim()); };
            Controls.Add(go);

            FlatBtn refresh = new FlatBtn("刷新", Color.White, Theme.AccentDeep);
            refresh.NormalBorder = Theme.Border;
            refresh.Font = Theme.Ui(9f, true);
            refresh.SetBounds(Dpi.X(560), Dpi.X(66), Dpi.X(84), Dpi.X(28));
            refresh.Click += delegate { search.Text = ""; Reload(""); };
            Controls.Add(refresh);

            list = new ListView();
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HideSelection = false;
            list.BorderStyle = BorderStyle.FixedSingle;
            list.BackColor = Color.White;
            list.Font = Theme.Ui(9f, false);
            list.SetBounds(Dpi.X(16), Dpi.X(106), 0, 0);
            list.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            list.Columns.Add("内容", Dpi.X(458));
            list.Columns.Add("类型", Dpi.X(72));
            list.Columns.Add("时间", Dpi.X(136));
            list.SmallImageList = new ImageList();
            list.SmallImageList.ImageSize = new Size(1, Dpi.X(28));
            list.AccessibleName = "memList";
            list.DoubleClick += delegate { ShowSelectedDetail(); };
            Controls.Add(list);

            FlatBtn del = new FlatBtn("删除选中", Color.White, Theme.Warn);
            del.NormalBorder = Theme.Border;
            del.Font = Theme.Ui(9f, true);
            del.AccessibleName = "memDelete";
            del.SetBounds(Dpi.X(16), Dpi.X(516), Dpi.X(104), Dpi.X(30));
            del.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            del.Click += delegate
            {
                if (list.SelectedIndices.Count == 0) { hint.Text = "先选一条再删"; return; }
                string id = ids[list.SelectedIndices[0]];
                try
                {
                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["id"] = id;
                    api.Post("/api/memory/archive", body, 5000);
                    hint.Text = "已删除（归档），刷新一下还能看见";
                    Reload(search.Text.Trim());
                }
                catch (Exception ex) { hint.Text = "删除失败：" + ex.Message; }
            };
            Controls.Add(del);

            hint = new Label();
            hint.AutoSize = false;
            hint.ForeColor = Theme.Dim;
            hint.Font = Theme.Ui(8.5f, false);
            hint.SetBounds(Dpi.X(132), Dpi.X(522), Dpi.X(520), Dpi.X(22));
            hint.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(hint);

            Resize += delegate { LayoutList(); ApplyRound(); };
            LayoutList();
            ApplyRound();
            Reload("");
        }

        void LayoutList()
        {
            int top = Dpi.X(106);
            int bottomBar = Dpi.X(64);
            int w = Math.Max(Dpi.X(200), ClientSize.Width - Dpi.X(32));
            int h = Math.Max(Dpi.X(80), ClientSize.Height - top - bottomBar);
            list.SetBounds(Dpi.X(16), top, w, h);
            int timeW = Dpi.X(146);
            int kindW = Dpi.X(76);
            list.Columns[0].Width = Math.Max(Dpi.X(140), w - timeW - kindW - Dpi.X(22));
            list.Columns[1].Width = kindW;
            list.Columns[2].Width = timeW;
            if (hint != null) hint.SetBounds(Dpi.X(132), ClientSize.Height - Dpi.X(38), ClientSize.Width - Dpi.X(150), Dpi.X(22));
        }

        void DragDialog(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, 0xA1, (IntPtr)0x2, IntPtr.Zero);
        }

        void ApplyRound()
        {
            try
            {
                int pref = 2;
                if (Native.DwmSetWindowAttribute(Handle, 33, ref pref, 4) == 0) { Region = null; return; }
            }
            catch { }
            try
            {
                using (GraphicsPath gp = Theme.Round(new Rectangle(0, 0, Width, Height), Dpi.X(14)))
                    Region = new Region(gp);
            }
            catch { }
        }

        void UpdateSearchHint()
        {
            if (searchHint != null) searchHint.Visible = search.Text.Length == 0;
        }

        static string KindName(string kind)
        {
            string k = String.IsNullOrEmpty(kind) ? "?" : kind;
            if (k == "fact") return "事实";
            if (k == "pref" || k == "preference") return "偏好";
            if (k == "relation" || k == "relationship") return "关系";
            if (k == "event") return "事件";
            if (k == "rule") return "规则";
            if (k == "lesson") return "经验";
            if (k == "topic") return "话题";
            if (k == "promise" || k == "agreement") return "约定";
            return k;
        }

        void Reload(string query)
        {
            try
            {
                string path = "/api/memory" + (query.Length > 0 ? ("?query=" + Uri.EscapeDataString(query) + "&k=20") : "");
                Dictionary<string, object> r = api.Get(path, 5000);
                object items;
                list.Items.Clear();
                ids.Clear();
                rows.Clear();
                if (r.TryGetValue("hits", out items) && items is object[])
                {
                    foreach (object o in (object[])items) AddRow((Dictionary<string, object>)o);
                    hint.Text = "搜索「" + query + "」命中 " + list.Items.Count + " 条";
                }
                else if (r.TryGetValue("items", out items) && items is object[])
                {
                    foreach (object o in (object[])items) AddRow((Dictionary<string, object>)o);
                    hint.Text = "共 " + list.Items.Count + " 条（最近 50）· 双击看全文";
                }
                else
                {
                    hint.Text = "还没有记忆。聊到约定、偏好、重要日子，她会自己记。";
                }
                UpdateSearchHint();
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
            rows.Add(new string[] { text, KindName(kind), at });
            list.Items.Add(new ListViewItem(new string[] { text, KindName(kind), at }));
        }

        void ShowSelectedDetail()
        {
            if (list.SelectedIndices.Count == 0) return;
            int i = list.SelectedIndices[0];
            if (i < 0 || i >= rows.Count) return;
            string[] r = rows[i];
            MessageBox.Show(this, r[0], r[1] + " · " + r[2], MessageBoxButtons.OK, MessageBoxIcon.Information);
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
        // 读「服务当前用的配置」里第一家的模型名（不读本地文件：安装版和仓库可能是两份配置）
        static string FirstModelViaApi(ApiClient api)
        {
            try
            {
                Dictionary<string, object> r = api.GetConfig(5000);
                Dictionary<string, object> cfg = (r.ContainsKey("config") && r["config"] is Dictionary<string, object>)
                    ? (Dictionary<string, object>)r["config"] : r;
                object arr;
                if (cfg.TryGetValue("providers", out arr) && arr is object[] && ((object[])arr).Length > 0)
                {
                    Dictionary<string, object> p = ((object[])arr)[0] as Dictionary<string, object>;
                    if (p != null && p.ContainsKey("model")) return Convert.ToString(p["model"]);
                }
            }
            catch { }
            return "";
        }

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
                string probe = "qwen3-8b-tool-verify";
                // 别读本地文件：服务可能用的是安装版那份 config.json，按接口读才准
                string before = FirstModelViaApi(api);
                SettingsForm.SaveModelViaApi(api, probe);
                string after = FirstModelViaApi(api);
                Console.WriteLine("CONFIG before=" + before + " -> after=" + after + " (设置窗同一条保存路径)");
                if (after != probe) fail++;
                if (before.Length > 0) SettingsForm.SaveModelViaApi(api, before);
                string restored = FirstModelViaApi(api);
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

        // 离屏抓一张窗体图（UI 复查/文档用）
        static void Shot(Form f, string png)
        {
            try
            {
                using (Bitmap bmp = new Bitmap(f.Width, f.Height))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        IntPtr hdc = g.GetHdc();
                        bool ok = Native.PrintWindow(f.Handle, hdc, 0);
                        g.ReleaseHdc(hdc);
                        if (!ok) { hdc = g.GetHdc(); Native.PrintWindow(f.Handle, hdc, 0); g.ReleaseHdc(hdc); }
                    }
                    bmp.Save(png, System.Drawing.Imaging.ImageFormat.Png);
                }
                Console.WriteLine("SHOT " + png);
            }
            catch (Exception ex) { Console.WriteLine("SHOT FAIL " + png + " :: " + ex.Message); }
        }

        // 离屏把设置页、记忆页各拍一张（给文档和 UI 复查用，不弹到他眼前）
        static int ShootPanels(string repo, string baseUrl)
        {
            ServiceKeeper k = new ServiceKeeper(baseUrl, repo);
            if (!k.Ensure(20000)) { Console.WriteLine("FAIL 服务没起来"); return 1; }
            ApiClient api = new ApiClient(baseUrl);
            try
            {
                using (SettingsForm s = new SettingsForm(api, repo))
                {
                    s.StartPosition = FormStartPosition.Manual;
                    s.Location = new Point(-30000, -30000);
                    s.ShowInTaskbar = false;
                    s.Show();
                    Application.DoEvents();
                    Thread.Sleep(600);
                    Application.DoEvents();
                    Shot(s, Path.Combine(repo, "data", "_ui_settings.png"));
                    s.Hide();
                }
            }
            catch (Exception ex) { Console.WriteLine("SETTINGS SHOT FAIL " + ex.Message); }
            try
            {
                using (MemoryForm m = new MemoryForm(api))
                {
                    m.StartPosition = FormStartPosition.Manual;
                    m.Location = new Point(-30000, -30000);
                    m.ShowInTaskbar = false;
                    m.Show();
                    Application.DoEvents();
                    Thread.Sleep(600);
                    Application.DoEvents();
                    Shot(m, Path.Combine(repo, "data", "_ui_memory.png"));
                    m.Hide();
                }
            }
            catch (Exception ex) { Console.WriteLine("MEMORY SHOT FAIL " + ex.Message); }
            try
            {
                using (MainForm mf = new MainForm(repo, baseUrl, false))
                {
                    mf.StartPosition = FormStartPosition.Manual;
                    mf.Location = new Point(-30000, -30000);
                    mf.ShowInTaskbar = false;
                    mf.Show();
                    Application.DoEvents();
                    Thread.Sleep(400);
                    Application.DoEvents();
                    Shot(mf, Path.Combine(repo, "data", "_ui_main.png"));
                    Dictionary<string, object> cost = api.Get("/api/cost?days=7", 5000);
                    using (Form cf = mf.MakeCostForm(cost))
                    {
                        cf.StartPosition = FormStartPosition.Manual;
                        cf.Location = new Point(-30000, -30000);
                        cf.ShowInTaskbar = false;
                        cf.Show();
                        Application.DoEvents();
                        Thread.Sleep(300);
                        Application.DoEvents();
                        Shot(cf, Path.Combine(repo, "data", "_ui_cost.png"));
                        cf.Hide();
                    }
                    mf.Hide();
                }
            }
            catch (Exception ex) { Console.WriteLine("COST SHOT FAIL " + ex.Message); }
            try
            {
                using (PluginsForm pf = new PluginsForm(api))
                {
                    pf.StartPosition = FormStartPosition.Manual;
                    pf.Location = new Point(-30000, -30000);
                    pf.ShowInTaskbar = false;
                    pf.Show();
                    Application.DoEvents();
                    Thread.Sleep(600);
                    Application.DoEvents();
                    Shot(pf, Path.Combine(repo, "data", "_ui_plugins.png"));
                    pf.Hide();
                }
            }
            catch (Exception ex) { Console.WriteLine("PLUGINS SHOT FAIL " + ex.Message); }
            return 0;
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
                else if (args[i] == "--shots") mode = "shots";

            }
            if (mode == "shots") return ShootPanels(repo, baseUrl);
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

    // ===================== 插件：装 / 启停 / 卸载 / 跑插件自己的按钮 =====================
    class PluginsForm : Form
    {
        readonly ApiClient api;
        ListView list;
        Label hint;
        FlatBtn btnToggle;
        FlatBtn btnInstall;
        FlatBtn btnUninstall;
        FlatBtn btnRun;
        FlatBtn btnFolder;
        FlatBtn btnRefresh;
        FlatBtn btnClose;
        List<string> names = new List<string>();
        List<bool> enabledFlags = new List<bool>();
        List<string> uiLabels = new List<string>();
        List<string> dirs = new List<string>();

        public PluginsForm(ApiClient api)
        {
            this.api = api;
            Text = "插件 · 鲸倩";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = false;
            Font = Theme.Ui(9f, false);
            BackColor = Theme.Paper;
            ClientSize = new Size(Dpi.X(760), Dpi.X(470));
            try { string ico = Path.Combine(Application.StartupPath, "icon.ico"); if (File.Exists(ico)) Icon = new Icon(ico); } catch { }

            Label title = new Label();
            title.Text = "插件";
            title.Font = Theme.Ui(12f, true);
            title.ForeColor = Theme.Text;
            title.SetBounds(Dpi.X(18), Dpi.X(12), Dpi.X(200), Dpi.X(26));
            Controls.Add(title);

            Label sub = new Label();
            sub.Text = "装进本地目录的插件，用清单声明权限；装完要「启用」才会加载。";
            sub.ForeColor = Theme.Dim;
            sub.Font = Theme.Ui(8.5f, false);
            sub.SetBounds(Dpi.X(18), Dpi.X(40), Dpi.X(700), Dpi.X(22));
            Controls.Add(sub);

            list = new ListView();
            list.View = View.Details;
            list.FullRowSelect = true;
            list.HideSelection = false;
            list.BorderStyle = BorderStyle.FixedSingle;
            list.Font = Theme.Ui(9f, false);
            list.BackColor = Color.White;
            list.SetBounds(Dpi.X(18), Dpi.X(68), Dpi.X(724), Dpi.X(280));
            list.Columns.Add("名字", Dpi.X(130));
            list.Columns.Add("版本", Dpi.X(66));
            list.Columns.Add("状态", Dpi.X(120));
            list.Columns.Add("权限", Dpi.X(150));
            list.Columns.Add("说明", Dpi.X(250));
            list.SelectedIndexChanged += delegate { UpdateButtons(); };
            list.DoubleClick += delegate { Toggle(); };
            Controls.Add(list);

            hint = new Label();
            hint.AutoSize = false;
            hint.ForeColor = Theme.Dim;
            hint.Font = Theme.Ui(8.5f, false);
            hint.SetBounds(Dpi.X(18), Dpi.X(354), Dpi.X(724), Dpi.X(44));
            hint.Text = "插件和服务同一个进程（可信插件模式）：只装你自己看过、信得过的。";
            Controls.Add(hint);

            btnToggle = Make("启用/停用", delegate { Toggle(); });
            btnInstall = Make("安装…", delegate { Install(); });
            btnUninstall = Make("卸载", delegate { Uninstall(); });
            btnRun = Make("运行插件按钮", delegate { RunUi(); });
            btnFolder = Make("插件目录", delegate { OpenFolder(); });
            btnRefresh = Make("刷新", delegate { LoadList(); });
            btnClose = Make("关闭", delegate { Close(); });

            int x = Dpi.X(18);
            int y = Dpi.X(406);
            foreach (FlatBtn b in new FlatBtn[] { btnToggle, btnInstall, btnUninstall, btnRun, btnFolder, btnRefresh })
            {
                if (b == null) continue;
                b.SetBounds(x, y, b.Width, Dpi.X(30));
                x += b.Width + Dpi.X(8);
            }
            btnClose.SetBounds(Dpi.X(760 - 18 - btnClose.Width), y, btnClose.Width, Dpi.X(30));
            Controls.Add(btnClose);

            LoadList();
        }

        FlatBtn Make(string text, EventHandler click)
        {
            FlatBtn b = new FlatBtn(text, Color.White, Theme.AccentDeep);
            b.NormalBorder = Theme.Border;
            b.Font = Theme.Ui(9f, false);
            b.Size = new Size(TextRenderer.MeasureText(text, b.Font).Width + Dpi.X(24), Dpi.X(30));
            b.Click += click;
            Controls.Add(b);
            return b;
        }

        void LoadList()
        {
            list.Items.Clear();
            names.Clear(); enabledFlags.Clear(); uiLabels.Clear(); dirs.Clear();
            Dictionary<string, object> r;
            try { r = api.Get("/api/plugins", 8000); }
            catch (Exception ex)
            {
                hint.Text = "服务没接上：" + ex.Message;
                UpdateButtons();
                return;
            }
            object arr;
            if (r.TryGetValue("items", out arr) && arr is object[])
            {
                foreach (object o in (object[])arr)
                {
                    Dictionary<string, object> d = o as Dictionary<string, object>;
                    if (d == null) continue;
                    string name = d.ContainsKey("name") ? Convert.ToString(d["name"]) : "";
                    string ver = d.ContainsKey("version") ? Convert.ToString(d["version"]) : "";
                    bool en = d.ContainsKey("enabled") && Convert.ToBoolean(d["enabled"]);
                    bool loaded = d.ContainsKey("loaded") && Convert.ToBoolean(d["loaded"]);
                    string err = d.ContainsKey("error") ? Convert.ToString(d["error"]) : "";
                    string perms = "";
                    object pv;
                    if (d.TryGetValue("permissions", out pv) && pv is object[])
                    {
                        List<string> ps = new List<string>();
                        foreach (object p in (object[])pv) ps.Add(Convert.ToString(p));
                        perms = string.Join("、", ps.ToArray());
                    }
                    string status = err.Length > 0 ? "加载失败" : (en ? (loaded ? "已启用" : "已启用·未加载") : "未启用");
                    string desc = d.ContainsKey("description") ? Convert.ToString(d["description"]) : "";
                    if (err.Length > 0) desc = "！" + err;
                    ListViewItem it = new ListViewItem(name);
                    it.SubItems.Add(ver);
                    it.SubItems.Add(status);
                    it.SubItems.Add(perms);
                    it.SubItems.Add(desc);
                    list.Items.Add(it);
                    names.Add(name);
                    enabledFlags.Add(en);
                    uiLabels.Add(d.ContainsKey("ui") ? Convert.ToString(d["ui"]) : "");
                    dirs.Add(d.ContainsKey("dir") ? Convert.ToString(d["dir"]) : "");
                }
            }
            if (names.Count == 0) hint.Text = "还没装插件。点「安装…」选一个插件目录（里面有 plugin.json）。";
            else hint.Text = "共 " + names.Count + " 个插件。插件和服务同一个进程（可信插件模式）：只装你自己看过、信得过的。";
            UpdateButtons();
        }

        void UpdateButtons()
        {
            bool has = list.SelectedIndices.Count > 0;
            btnToggle.Enabled = has;
            btnUninstall.Enabled = has;
            btnRun.Enabled = has && list.SelectedIndices[0] < uiLabels.Count && uiLabels[list.SelectedIndices[0]].Length > 0;
        }

        string SelectedName()
        {
            if (list.SelectedIndices.Count == 0) return "";
            int i = list.SelectedIndices[0];
            return i < names.Count ? names[i] : "";
        }

        void Toggle()
        {
            int i = list.SelectedIndices.Count > 0 ? list.SelectedIndices[0] : -1;
            if (i < 0 || i >= names.Count) return;
            string act = enabledFlags[i] ? "disable" : "enable";
            try
            {
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["name"] = names[i];
                Dictionary<string, object> r = api.Post("/api/plugins/" + act, body, 10000);
                if (r.ContainsKey("ok") && !Convert.ToBoolean(r["ok"])) MessageBox.Show(this, Convert.ToString(r["error"]), "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception ex) { MessageBox.Show(this, "操作失败：" + ex.Message, "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            LoadList();
        }

        void Install()
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "选一个插件目录（里面要有 plugin.json 和入口文件）";
                if (d.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    Dictionary<string, object> body = new Dictionary<string, object>();
                    body["path"] = d.SelectedPath;
                    Dictionary<string, object> r = api.Post("/api/plugins/install", body, 15000);
                    if (!r.ContainsKey("ok") || !Convert.ToBoolean(r["ok"]))
                        MessageBox.Show(this, Convert.ToString(r.ContainsKey("error") ? r["error"] : "装不上"), "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    else
                        MessageBox.Show(this, "装好了。还要在列表里选中它，点一次「启用」才会加载。", "插件", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch (Exception ex) { MessageBox.Show(this, "安装失败：" + ex.Message, "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                LoadList();
            }
        }

        void Uninstall()
        {
            string name = SelectedName();
            if (name.Length == 0) return;
            if (MessageBox.Show(this, "卸载「" + name + "」？会把它的目录一起删掉（插件自己的数据也在里面）。", "插件",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            try
            {
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["name"] = name;
                Dictionary<string, object> r = api.Post("/api/plugins/uninstall", body, 10000);
                if (!r.ContainsKey("ok") || !Convert.ToBoolean(r["ok"]))
                    MessageBox.Show(this, Convert.ToString(r.ContainsKey("error") ? r["error"] : "卸载失败"), "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception ex) { MessageBox.Show(this, "卸载失败：" + ex.Message, "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            LoadList();
        }

        void RunUi()
        {
            string name = SelectedName();
            if (name.Length == 0) return;
            try
            {
                Dictionary<string, object> body = new Dictionary<string, object>();
                body["name"] = name;
                Dictionary<string, object> r = api.Post("/api/plugins/ui", body, 15000);
                string text = (r.ContainsKey("ok") && Convert.ToBoolean(r["ok"]))
                    ? Convert.ToString(r["result"])
                    : Convert.ToString(r.ContainsKey("error") ? r["error"] : "没有结果");
                MessageBox.Show(this, text, "插件 · " + name, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex) { MessageBox.Show(this, "跑不动：" + ex.Message, "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }

        void OpenFolder()
        {
            string dir = dirs.Count > 0 ? Path.GetDirectoryName(dirs[0]) : "";
            if (dir.Length == 0) { MessageBox.Show(this, "还没装插件，目录也还不知道。装一个之后再来。", "插件", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            try { System.Diagnostics.Process.Start("explorer.exe", "\"" + dir + "\""); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "插件", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
        }
    }
}
