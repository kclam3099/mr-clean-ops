/** Simplified Chinese for the shell area. Key = the exact English source text. */
export const shell: Record<string, string> = {
  "Monitoring login — you are signed in as {name}.": "监控登录 — 你正以 {name} 的身份登录。",
  // Login
  "Operations": "运营管理",
  "Internal system. Accounts are created by a manager.": "内部系统。账号由经理创建。",
  "Username": "用户名",
  "e.g. JACK": "例如 JACK",
  "Your name. Capitals do not matter.": "填你的名字，大小写都可以。",
  "Password": "密码",
  "Sign in": "登录",
  "Signing in…": "正在登录…",

  // Sign-in errors (lib/auth/actions.ts)
  "Enter your username and password.": "请输入用户名和密码。",
  "Incorrect username or password.": "用户名或密码错误。",
  "This account is not active. Please contact your manager.": "此账号未启用，请联系你的经理。",

  // Change password
  "Choose your password": "设置你的密码",
  "Your manager gave you a temporary one. Pick your own before you start.":
    "经理给你的是临时密码，开始使用前请先设置自己的密码。",
  "Set a new password for your account.": "为你的账号设置新密码。",
  "Signed in as {name}.": "当前登录：{name}。",
  "New password": "新密码",
  "At least 8 characters. Not your phone number.": "至少 8 个字符，不能用电话号码。",
  "Type it again": "再输入一次",
  "Save password": "保存密码",
  "Saving…": "正在保存…",

  // Change-password errors (lib/auth/password-actions.ts)
  "Use at least 8 characters.": "请至少使用 8 个字符。",
  "The two passwords do not match.": "两次输入的密码不一致。",
  "Do not use a phone number. Choose something else.": "不要用电话号码，请换一个密码。",
  "Your password was changed, but we could not finish setting up your account. Sign in again with the new password.":
    "密码已更改，但账号设置未能完成。请用新密码重新登录。",

  // Navigation
  "Today": "今天",
  "Tomorrow": "明天",
  "Month": "本月",
  "Calendar": "日历",
  "Appointments": "预约",
  "Staff": "员工",
  "Availability": "空档",
  "Reports": "报表",
  "Settings": "设置",
  "Workspace": "工作区",
  "All Operations": "全部团队",

  // Account menu
  "Signed in as": "当前登录：",
  "Change password": "更改密码",
  "Sign out": "登出",
  "Signing out…": "正在登出…",

  // Loading / placeholders
  "Loading…": "加载中…",
  "Audit Log": "审计日志",
  "Staff Detail": "员工详情",
  "Not implemented yet — Phase 1 scaffold placeholder.": "尚未开放 —— 第一阶段占位页面。",

  // Errors (lib/errors/appError.ts MESSAGES)
  "This team member is not available at that time. Please choose another time or another person.":
    "该员工在这个时间没空，请另选时间或其他员工。",
  "A large job is holding the rest of that day. A Master can approve an exception with a reason.":
    "当天剩余时间已被大单占用。主管可填写理由进行例外批准。",
  "That time overlaps an existing appointment. Overlapping bookings are never allowed.":
    "这个时间与已有预约重叠，不允许重叠预约。",
  "That time is outside working hours.": "这个时间不在工作时间内。",
  "This team member is on time off then.": "该员工当时在休假。",
  "That time has already passed. Please choose a future date and time.":
    "这个时间已经过了，请选择未来的日期和时间。",
  "There are upcoming appointments that need to be moved or cancelled first.":
    "还有即将到来的预约，需要先改期或取消。",
  "You do not have permission to do that.": "你没有权限进行此操作。",
  "This appointment can no longer be changed because it is completed or cancelled.":
    "此预约已完成或已取消，无法再更改。",
  "Please check the details and try again.": "请检查资料后再试一次。",
  "Something went wrong. Please try again.": "出了点问题，请再试一次。",
  "Conflicting appointment starts at {time}.": "冲突的预约于 {time} 开始。",
  "Working hours are {start}–{end}.": "工作时间为 {start}–{end}。",
};
