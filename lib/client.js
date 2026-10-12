window.__ModuleLoader__.load({
  id: "dsh-mail-guardian",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    function MailReport() {
      const [report, setReport] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        let stopped = false;
        let controller = null;
        async function update() {
          controller?.abort();
          controller = new AbortController();
          try {
            const r = await fetch("/api/dsh-mail-guardian/report", {
              credentials: "same-origin",
              cache: "no-store",
              signal: controller.signal,
            });
            if (!r.ok) throw new Error("unavailable");
            const v = await r.json();
            if (!stopped) {
              setReport(v);
              setFailed(false);
            }
          } catch {
            if (!stopped) setFailed(true);
          }
        }
        update();
        const t = setInterval(update, 30000);
        return () => {
          stopped = true;
          clearInterval(t);
          controller?.abort();
        };
      }, []);
      React.useEffect(() => {
        if (report?.day) {
          try {
            if (
              localStorage.getItem("dsh-mail-guardian:last-report-day") !==
              report.day
            ) {
              setOpen(true);
              localStorage.setItem(
                "dsh-mail-guardian:last-report-day",
                report.day,
              );
            }
          } catch {
            setOpen(true);
          }
        }
      }, [report?.day]);
      return h(
        "details",
        {
          className: "mail-guardian-report",
          open,
          onToggle: (e) => setOpen(e.currentTarget.open),
          style: {
            width: "100%",
            maxWidth: 340,
            padding: "8px 10px",
            border: "1px solid var(--dsw-alias-border-l2,#7775)",
            borderRadius: 8,
            boxSizing: "border-box",
          },
        },
        h(
          "summary",
          { style: { cursor: "pointer", fontSize: 13, fontWeight: 600 } },
          "✉ 邮箱简报",
          report ? " · " + report.day : " · 正在读本机缓存",
        ),
        failed
          ? h("p", null, "暂时读不到本机报告，不能判断有没有新邮件。")
          : null,
        h(
          "div",
          {
            style: {
              whiteSpace: "pre-wrap",
              fontSize: 12,
              lineHeight: 1.7,
              maxHeight: "48vh",
              overflow: "auto",
              marginTop: 8,
            },
          },
          report?.text ?? "正在读取现成报告，不联网收信、不需要授权。",
        ),
      );
    }
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "mail-guardian",
            order: 40,
            inject: () => ({}),
          },
          MailReport,
        ),
      );
    }
    return { apply, inject: ["slots"], MailReport };
  },
});
