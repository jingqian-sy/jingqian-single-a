using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// 触手的「指一下」：在屏幕上画一个红圈 + 文字，停留 ms 毫秒后自动消失。
// 用法：overlay.exe <x> <y> [ms] [文字]
// 不抢焦点、不挡点击：窗口是透明 + 置顶 + 点穿。
class Overlay : Form
{
    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_NOACTIVATE = 0x08000000;

    int cx, cy;
    string label;
    int r = 46;

    public Overlay(int x, int y, string text)
    {
        cx = x; cy = y; label = text ?? "";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(0, 0, Screen.PrimaryScreen.Bounds.Width, Screen.PrimaryScreen.Bounds.Height);
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var pen = new Pen(Color.FromArgb(230, 40, 40), 3))
        {
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
        }
        using (var pen2 = new Pen(Color.FromArgb(120, 230, 40, 40), 1))
        {
            g.DrawEllipse(pen2, cx - r - 8, cy - r - 8, (r + 8) * 2, (r + 8) * 2);
        }
        // 十字准心
        using (var pen3 = new Pen(Color.FromArgb(200, 230, 40, 40), 2))
        {
            g.DrawLine(pen3, cx - 10, cy, cx + 10, cy);
            g.DrawLine(pen3, cx, cy - 10, cx, cy + 10);
        }
        if (!string.IsNullOrEmpty(label))
        {
            using (var font = new Font("Microsoft YaHei UI", 12f, FontStyle.Bold))
            using (var brush = new SolidBrush(Color.White))
            using (var bg = new SolidBrush(Color.FromArgb(220, 30, 30, 30)))
            {
                var sz = TextRenderer.MeasureText(label, font);
                var rect = new Rectangle(cx - sz.Width / 2 - 10, cy + r + 10, sz.Width + 20, sz.Height + 8);
                g.FillRectangle(bg, rect);
                TextRenderer.DrawText(g, label, font, rect, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length < 2) { Console.WriteLine("用法: overlay.exe <x> <y> [ms] [文字]"); return; }
        int x = int.Parse(args[0]);
        int y = int.Parse(args[1]);
        int ms = args.Length > 2 ? int.Parse(args[2]) : 1000;
        string text = args.Length > 3 ? args[3] : "";
        var f = new Overlay(x, y, text);
        var timer = new Timer();
        timer.Interval = Math.Max(200, ms);
        timer.Tick += (s, e) => { timer.Stop(); f.Close(); };
        timer.Start();
        Application.Run(f);
    }
}
