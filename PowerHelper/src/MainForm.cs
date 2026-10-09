using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

namespace PowerHelper
{
    internal sealed class MainForm : Form
    {
        // PBUTTONACTION index for "Turn off the display": one press turns the screen off while
        // the PC keeps running; pressing again (or touching mouse / keyboard) turns it back on.
        const uint DisplayOff = 4;

        static readonly uint[] TimeoutChoices = { 60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, 7200, 10800, 18000, 0 };
        static readonly string[] ButtonActionNames = { "不执行任何操作", "睡眠", "休眠", "关机", "关闭显示器（息屏⇄亮屏）" };

        readonly bool hasBattery = true;
        readonly List<Choice> buttonChoices;
        readonly List<SettingRow> rows = new List<SettingRow>();
        readonly SettingRow hibernateRow;
        readonly SettingRow buttonRow;

        readonly Label planLabel = NewLabel("");
        readonly Label hibernateLabel = NewLabel("");
        readonly Button enableHibernateButton = NewButton("启用休眠（需要管理员权限）");
        readonly Label policyLabel = NewLabel("");
        readonly Label statusLabel = NewLabel("");

        public MainForm()
        {
            try
            {
                hasBattery = PowerApi.GetCapabilities().HasBattery;
            }
            catch (Exception)
            {
                // Unknown: keep the battery column so nothing is hidden by mistake.
            }
            buttonChoices = LoadButtonChoices();

            SuspendLayout();
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Microsoft YaHei UI", 9F);
            Text = "电源助手";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;

            enableHibernateButton.Click += delegate { EnableHibernate(); };
            var displayOffButton = NewButton("一键设为“息屏⇄亮屏”");
            displayOffButton.Click += delegate { UseDisplayOffButton(); };
            var hint = NewLabel("按一下电源键：只关闭屏幕，电脑继续运行。\n再按一下电源键（或动鼠标、按任意键）：亮屏。");
            hint.ForeColor = SystemColors.GrayText;
            policyLabel.ForeColor = Color.Firebrick;
            policyLabel.MaximumSize = new Size(520, 0);
            policyLabel.Visible = false;
            statusLabel.ForeColor = SystemColors.GrayText;

            var reloadButton = NewButton("重新读取");
            reloadButton.Click += delegate { LoadSettings(); };
            var applyButton = NewButton("应用");
            applyButton.Click += delegate { ApplyAll(); };
            var closeButton = NewButton("关闭");
            closeButton.Click += delegate { Close(); };
            CancelButton = closeButton;
            var actions = NewFlow(closeButton, applyButton, reloadButton);
            actions.FlowDirection = FlowDirection.RightToLeft;
            actions.Dock = DockStyle.Fill;

            // One grid for the whole window (label | plugged in | on battery); full-width lines span all columns.
            var grid = new TableLayoutPanel
            {
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 3,
                Padding = new Padding(12),
            };
            for (int i = 0; i < grid.ColumnCount; i++)
                grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

            int line = 0;
            AddWide(grid, line++, planLabel);
            AddWide(grid, line++, NewSection("闲置多久后自动…"));
            AddHeader(grid, line++);
            rows.Add(AddRow(grid, line++, "关闭屏幕", PowerApi.SubVideo, PowerApi.VideoIdle, true));
            rows.Add(AddRow(grid, line++, "进入睡眠", PowerApi.SubSleep, PowerApi.StandbyIdle, true));
            hibernateRow = AddRow(grid, line++, "进入休眠", PowerApi.SubSleep, PowerApi.HibernateIdle, true);
            rows.Add(hibernateRow);
            AddWide(grid, line++, hibernateLabel);
            AddWide(grid, line++, enableHibernateButton);

            AddWide(grid, line++, NewSection("电源键"));
            AddHeader(grid, line++);
            buttonRow = AddRow(grid, line++, "按下电源键时", PowerApi.SubButtons, PowerApi.PowerButtonAction, false);
            rows.Add(buttonRow);
            AddWide(grid, line++, displayOffButton);
            AddWide(grid, line++, hint);

            AddWide(grid, line++, policyLabel);
            AddWide(grid, line++, actions);
            AddWide(grid, line++, statusLabel);
            Controls.Add(grid);

            ResumeLayout(false);
            PerformLayout();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            LoadSettings();
        }

        void LoadSettings()
        {
            try
            {
                var scheme = PowerApi.GetActiveScheme();
                planLabel.Text = "当前电源计划：" + (PowerApi.GetSchemeName(scheme) ?? scheme.ToString());
                foreach (var row in rows)
                {
                    row.Select(row.Ac, PowerApi.ReadValue(scheme, row.SubGroup, row.Setting, true));
                    if (row.Dc != null)
                        row.Select(row.Dc, PowerApi.ReadValue(scheme, row.SubGroup, row.Setting, false));
                }
                UpdateHibernateState();
                UpdatePolicyNotice();
                statusLabel.Text = "已读取当前设置。修改后请点击“应用”。";
            }
            catch (Exception ex)
            {
                ShowError("读取电源设置失败：" + ex.Message);
            }
        }

        void ApplyAll()
        {
            if (Apply(rows))
            {
                LoadSettings();
                statusLabel.Text = "设置已生效（" + DateTime.Now.ToString("HH:mm:ss") + "）";
            }
        }

        void UseDisplayOffButton()
        {
            var choice = Find(buttonRow.Ac, DisplayOff);
            if (choice == null)
            {
                ShowError("这台电脑的 Windows 版本不支持把电源键设为“关闭显示器”。");
                return;
            }
            buttonRow.Ac.SelectedItem = choice;
            if (buttonRow.Dc != null)
                buttonRow.Dc.SelectedItem = Find(buttonRow.Dc, DisplayOff) ?? buttonRow.Dc.SelectedItem;

            // Only the power button is written; pending edits in the other rows stay as they are.
            if (Apply(new[] { buttonRow }))
                statusLabel.Text = "电源键已设为“关闭显示器”：按一下息屏，再按一下亮屏。";
        }

        bool Apply(IEnumerable<SettingRow> targets)
        {
            try
            {
                var scheme = PowerApi.GetActiveScheme();
                foreach (var row in targets)
                {
                    if (!row.Ac.Enabled)
                        continue; // hibernation is off, so its timer cannot be set
                    Write(scheme, row, row.Ac, true);
                    if (row.Dc != null)
                        Write(scheme, row, row.Dc, false);
                }
                PowerApi.Activate(scheme);
                return true;
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == PowerApi.ErrorAccessDenied)
            {
                ShowError("没有权限修改电源设置。\n请右键点击本程序，选择“以管理员身份运行”后再试。");
            }
            catch (Exception ex)
            {
                ShowError("应用设置失败：" + ex.Message);
            }
            return false;
        }

        static void Write(Guid scheme, SettingRow row, ComboBox box, bool pluggedIn)
        {
            var choice = box.SelectedItem as Choice;
            if (choice != null)
                PowerApi.WriteValue(scheme, row.SubGroup, row.Setting, pluggedIn, choice.Value);
        }

        void EnableHibernate()
        {
            try
            {
                if (!PowerApi.EnableHibernate())
                {
                    statusLabel.Text = "已取消启用休眠。";
                    return;
                }
            }
            catch (Exception ex)
            {
                ShowError("启用休眠失败：" + ex.Message);
                return;
            }
            UpdateHibernateState();
            if (hibernateRow.Ac.Enabled)
                statusLabel.Text = "休眠功能已启用，现在可以设置“进入休眠”的时间。";
            else
                ShowError("休眠仍未启用。这台电脑可能不支持休眠（例如虚拟机，或硬件 / 固件未提供休眠）。");
        }

        void UpdateHibernateState()
        {
            bool enabled;
            try
            {
                enabled = PowerApi.GetCapabilities().HibernateEnabled;
            }
            catch (Exception)
            {
                enabled = true; // unknown: do not block the setting
            }
            hibernateRow.Ac.Enabled = enabled;
            if (hibernateRow.Dc != null)
                hibernateRow.Dc.Enabled = enabled;
            hibernateLabel.Text = enabled ? "休眠功能：已启用" : "休眠功能未启用，无法设置“进入休眠”";
            enableHibernateButton.Visible = !enabled;
        }

        void UpdatePolicyNotice()
        {
            var managed = new List<string>();
            foreach (var row in rows)
            {
                if (PowerApi.IsSetByPolicy(row.Setting))
                    managed.Add(row.Name);
            }
            policyLabel.Visible = managed.Count > 0;
            policyLabel.Text = "注意：“" + string.Join("、", managed) + "”由组织（如医院 IT 部门）的组策略统一管理，在这里修改可能不会生效。";
        }

        void ShowError(string message)
        {
            MessageBox.Show(this, message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        SettingRow AddRow(TableLayoutPanel grid, int rowIndex, string name, Guid subGroup, Guid setting, bool isTimeout)
        {
            var row = new SettingRow
            {
                Name = name,
                SubGroup = subGroup,
                Setting = setting,
                IsTimeout = isTimeout,
                Ac = isTimeout ? NewTimeoutCombo() : NewCombo(buttonChoices),
                Dc = hasBattery ? (isTimeout ? NewTimeoutCombo() : NewCombo(buttonChoices)) : null,
            };
            grid.Controls.Add(NewLabel(name), 0, rowIndex);
            grid.Controls.Add(row.Ac, 1, rowIndex);
            if (row.Dc != null)
                grid.Controls.Add(row.Dc, 2, rowIndex);
            return row;
        }

        void AddHeader(TableLayoutPanel grid, int rowIndex)
        {
            // Desktops have no battery: a single column needs no header.
            if (!hasBattery)
                return;
            grid.Controls.Add(NewLabel("插电时"), 1, rowIndex);
            grid.Controls.Add(NewLabel("使用电池时"), 2, rowIndex);
        }

        static void AddWide(TableLayoutPanel grid, int rowIndex, Control control)
        {
            grid.Controls.Add(control, 0, rowIndex);
            grid.SetColumnSpan(control, grid.ColumnCount);
        }

        static List<Choice> LoadButtonChoices()
        {
            // Ask Windows which actions this PC offers ("Turn off the display" is missing on old builds).
            var choices = new List<Choice>();
            for (uint index = 0; index < 10; index++)
            {
                string systemName;
                try
                {
                    systemName = PowerApi.GetPossibleValueName(PowerApi.SubButtons, PowerApi.PowerButtonAction, index);
                }
                catch (Exception)
                {
                    break;
                }
                if (systemName != null)
                    choices.Add(new Choice(index, index < ButtonActionNames.Length ? ButtonActionNames[index] : systemName));
            }
            if (choices.Count == 0)
            {
                for (uint index = 0; index < ButtonActionNames.Length; index++)
                    choices.Add(new Choice(index, ButtonActionNames[index]));
            }
            return choices;
        }

        static Choice Find(ComboBox box, uint value)
        {
            foreach (Choice choice in box.Items)
            {
                if (choice.Value == value)
                    return choice;
            }
            return null;
        }

        static string DescribeTimeout(uint seconds)
        {
            if (seconds == 0)
                return "从不";
            if (seconds % 3600 == 0)
                return (seconds / 3600) + " 小时";
            if (seconds % 60 == 0)
                return (seconds / 60) + " 分钟";
            return seconds + " 秒";
        }

        static ComboBox NewTimeoutCombo()
        {
            var choices = new List<Choice>();
            foreach (var seconds in TimeoutChoices)
                choices.Add(new Choice(seconds, DescribeTimeout(seconds)));
            return NewCombo(choices);
        }

        static ComboBox NewCombo(IEnumerable<Choice> choices)
        {
            var box = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                Width = 200,
                Anchor = AnchorStyles.Left,
                MaxDropDownItems = 16,
            };
            foreach (var choice in choices)
                box.Items.Add(choice);
            return box;
        }

        static Label NewLabel(string text)
        {
            return new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 12, 6) };
        }

        static Button NewButton(string text)
        {
            return new Button
            {
                Text = text,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                MinimumSize = new Size(88, 28),
                Padding = new Padding(8, 2, 8, 2),
                Anchor = AnchorStyles.Left,
            };
        }

        static FlowLayoutPanel NewFlow(params Control[] controls)
        {
            var flow = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = new Padding(0, 4, 0, 0) };
            flow.Controls.AddRange(controls);
            return flow;
        }

        Label NewSection(string title)
        {
            var label = NewLabel(title);
            label.Font = new Font(Font, FontStyle.Bold);
            label.Margin = new Padding(3, 14, 3, 4);
            return label;
        }

        sealed class SettingRow
        {
            public string Name;
            public Guid SubGroup;
            public Guid Setting;
            public bool IsTimeout;
            public ComboBox Ac;
            public ComboBox Dc; // null on PCs without a battery

            /// <summary>Selects <paramref name="value"/>, adding it when it was set elsewhere (e.g. "7 分钟" in Control Panel).</summary>
            public void Select(ComboBox box, uint value)
            {
                var existing = Find(box, value);
                if (existing != null)
                {
                    box.SelectedItem = existing;
                    return;
                }
                var custom = new Choice(value, IsTimeout ? DescribeTimeout(value) : "其他（" + value + "）");
                int insertAt = box.Items.Count;
                if (IsTimeout)
                {
                    // Keep ascending order with "从不" (0) last.
                    for (int i = 0; i < box.Items.Count; i++)
                    {
                        var item = (Choice)box.Items[i];
                        if (item.Value == 0 || item.Value > value)
                        {
                            insertAt = i;
                            break;
                        }
                    }
                }
                box.Items.Insert(insertAt, custom);
                box.SelectedItem = custom;
            }
        }

        sealed class Choice
        {
            public readonly uint Value;
            readonly string text;

            public Choice(uint value, string text)
            {
                Value = value;
                this.text = text;
            }

            public override string ToString()
            {
                return text;
            }
        }
    }
}
