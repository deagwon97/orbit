export type ConversationCommand = { name: string; description: string; usage?: string; duringTask: boolean };
export function suggestions(text: string, commands: ConversationCommand[]) {
  if (!/^\/[^\s]*$/.test(text)) return [];
  return commands.filter(command => command.name.startsWith(text.slice(1).toLowerCase()));
}
export function isCommand(text: string) { return text.trimStart().startsWith('/'); }
