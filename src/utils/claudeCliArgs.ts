export interface ClaudeCliLaunchOptions {
  model?: string;
  agent?: string;
  sessionName?: string;
}

export function buildClaudeCliArgs(options: ClaudeCliLaunchOptions): string[] {
  const args: string[] = [];

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  if (options.sessionName) {
    args.push('--name', options.sessionName);
  }

  return args;
}