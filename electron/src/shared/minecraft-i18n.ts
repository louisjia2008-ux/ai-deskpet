export const minecraftEn = {
  'permission.minecraftConnect': 'Connect Minecraft',
  'permission.minecraftConnect.detail': 'Connect or disconnect the independent Minecraft bot using the server you specify. No chat-provider credentials enter the game process.',
  'permission.minecraftControl': 'Minecraft basic tasks',
  'permission.minecraftControl.detail': 'Start or cancel bounded basic gathering, starter-house or farming tasks. Game actions can alter the connected world. Nether and End tasks are unavailable.',
  'permission.minecraftRead': 'Minecraft progress',
  'permission.minecraftRead.detail': 'Read the bot’s current task, observed progress, position, health and inventory.',
  'nav.minecraft': 'Minecraft',
  'minecraft.title': 'Play together in Minecraft',
  'minecraft.description': 'Invite your companion into a Java Edition world, give it a task, and follow its progress here.',
} as const;

export const minecraftZhCN: Record<keyof typeof minecraftEn, string> = {
  'permission.minecraftConnect': '连接 Minecraft',
  'permission.minecraftConnect.detail': '按你指定的服务器连接或断开独立机器人，聊天模型密钥不会进入游戏进程。',
  'permission.minecraftControl': 'Minecraft 基础任务',
  'permission.minecraftControl.detail': '开始或取消有限的基础采集、小屋或农田任务。游戏动作会改变已连接的世界；不开放下界或末地任务。',
  'permission.minecraftRead': 'Minecraft 进度',
  'permission.minecraftRead.detail': '读取机器人的当前任务、实际进度、位置、生命及背包。',
  'nav.minecraft': '陪玩',
  'minecraft.title': '一起玩 Minecraft',
  'minecraft.description': '让桌宠进入 Java 版世界，交给它一个任务，并在这里查看执行进度。',
};
