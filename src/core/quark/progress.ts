export const quarkLoginStages = {
  permissions: '后台检查授权',
  preparing: '准备二维码请求',
  queued: '等待前一次夸克请求结束',
  headers: '设置夸克请求头',
  fetching: '连接夸克二维码服务',
  cleanup: '清理临时请求头',
  parsing: '读取二维码响应',
  storing: '保存二维码会话',
  responding: '返回二维码至页面',
} as const

export type QuarkLoginStage = keyof typeof quarkLoginStages
export type LoginProgress = (stage: QuarkLoginStage) => void
