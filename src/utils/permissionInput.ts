export type PermissionChoice = 'yes' | 'no';

export function getPermissionReplySequence(choice: PermissionChoice): string {
  return choice === 'yes' ? '1\r' : '3\r';
}