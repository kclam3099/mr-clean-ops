/** Simplified Chinese for the appointment area. Key = the exact English source text. */
export const appointment: Record<string, string> = {
  "This appointment is completed. As Super Master you can still correct the customer details and services; its time slot stays as it was.":
    "这个预约已完成。你是超级主管，仍然可以修改客户资料和服务项目；预约时间不会改变。",
  "Appointments more than 3 days old can no longer be edited.": "超过 3 天的预约不能再修改。",
  "This appointment is more than 3 days old. You can view it and mark it completed, but it can no longer be edited.":
    "这个预约已超过 3 天。你可以查看并标记完成，但不能再修改。",
  "This appointment is more than 3 days old. You can view it, but it can no longer be edited.":
    "这个预约已超过 3 天。你可以查看，但不能再修改。",
  // --- appointment detail: header, status, history notice
  "Booked": "已预约",
  "Completed": "已完成",
  "Cancelled": "已取消",
  "Large job": "大单",
  "Back": "返回",
  "This appointment is {status}. It is kept as history and can no longer be changed — add-ons can still be recorded below.":
    "此预约{status}，已作为历史记录保存，不能再修改——仍可在下方记录附加服务。",
  "This appointment is {status}. It is kept as history and can no longer be changed.":
    "此预约{status}，已作为历史记录保存，不能再修改。",

  // --- summary
  "Total": "总额",
  "Duration": "时长",
  "+{min}m buffer": "+{min} 分钟缓冲",
  "Phone": "电话",
  "Area": "地区",
  "Address": "地址",
  "Workspace": "工作区",
  "Notes": "备注",
  "Reminder": "提醒",
  "Call": "打电话",
  "Directions": "导航",
  "Services": "服务项目",

  // --- actions
  "Edit customer": "编辑客户",
  "Edit services": "编辑服务",
  "Reschedule": "改期",
  "Mark completed": "标记完成",
  "Cancel appointment": "取消预约",

  // --- edit panels
  "Name": "姓名",
  "Phone / WhatsApp": "电话 / WhatsApp",
  "Area / city": "地区 / 城市",
  "(optional)": "（可选）",
  "New total": "新总额",
  "Estimated duration {duration}. The final duration and whether the new time still fits are confirmed by the system when you save.":
    "预计时长 {duration}。最终时长以及新时间是否仍可安排，将在保存时由系统确认。",
  "Date": "日期",
  "Time": "时间",
  "Available when checked — final availability is confirmed when saving.":
    "以上为查询时的空档——最终能否预约以保存时为准。",
  "Close": "关闭",
  "Cancel": "取消",
  "Save changes": "保存修改",
  "Saving…": "保存中…",

  // --- confirm dialog
  "Cancel this appointment?": "取消此预约？",
  "Mark this appointment completed?": "将此预约标记为已完成？",
  "It becomes history. It cannot be rescheduled, completed or restored afterwards.":
    "预约将成为历史记录，之后不能改期、标记完成或恢复。",
  "It becomes history. It cannot be edited, rescheduled or cancelled afterwards.":
    "预约将成为历史记录，之后不能编辑、改期或取消。",
  "Reason": "原因",
  "Keep it": "保留",
  "Working…": "处理中…",

  // --- add-ons
  "Add-ons": "附加服务",
  "· credited to {name}": "· 记入 {name}",
  "+ Add-on": "+ 附加服务",
  "Remove add-on {description}": "删除附加服务 {description}",
  "Remove \"{description}\" ({amount})?": "删除“{description}”（{amount}）？",
  "No add-ons yet. Sold something extra on site? Record it here.":
    "暂无附加服务。现场多卖了服务？在这里记录。",
  "Item": "项目",
  "e.g. Mattress cleaning": "例如：床垫清洗",
  "Amount (RM)": "金额 (RM)",
  "Save add-on": "保存附加服务",
  "Add-on total": "附加服务总额",

  // --- validation messages from lib/appointments/{lifecycle,addon}-actions.ts
  "Keep this under {max} characters": "请控制在 {max} 个字符以内",
  "What was added?": "请填写附加了什么",
  "Enter an amount": "请输入金额",
  "Amount must be more than 0": "金额必须大于 0",
  "That amount looks too large": "金额似乎过大",
  "Customer name is required": "请填写客户姓名",
  "Phone number is required": "请填写电话号码",
  "Address is required": "请填写地址",
  "Area or city is required": "请填写地区或城市",
  "Add at least one service item": "请至少添加一个服务项目",
  "Choose a date": "请选择日期",
  "Enter a time as HH:MM": "请按 HH:MM 格式输入时间",

  // --- pages
  "Appointments": "预约",
  "{scope} · next 30 days": "{scope} · 未来 30 天",
  "No appointments in the next 30 days.": "未来 30 天内没有预约。",
  "Appointment not available": "预约不可用",
  "This appointment does not exist, or is no longer available.": "此预约不存在，或已不可用。",
  "Back to calendar": "返回日历",
  "Back to today": "返回今天",
  "New appointment": "新预约",
  "No workspace available for booking.": "没有可用于预约的工作区。",
  "Choose the workspace and team member, then the job details.": "先选择工作区和团队成员，再填写工作详情。",
  "There is no workspace with active team members available to you.": "你没有可用的工作区（需有在职团队成员）。",
  "You are not an active member of any workspace, so you cannot create appointments. Please contact your manager.":
    "你不是任何工作区的在职成员，因此无法创建预约。请联系你的主管。",
  "Today": "今天",
  "+ New": "+ 新建",
  "Nothing scheduled today.": "今天没有安排。",
  "Tomorrow": "明天",
  "Nothing scheduled tomorrow.": "明天没有安排。",
  "This month": "本月",
  "{count} appointment(s)": "{count} 个预约",
  "Nothing scheduled this month.": "本月没有安排。",
};
