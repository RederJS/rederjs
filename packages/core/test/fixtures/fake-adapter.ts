import {
  Adapter,
  type AdapterContext,
  type OutboundMessage,
  type PermissionPrompt,
  type SendResult,
} from '../../src/adapter.js';

export class FakeAdapter extends Adapter {
  override readonly name: string;
  public sent: OutboundMessage[] = [];
  public prompts: PermissionPrompt[] = [];
  public canceled: Array<{ requestId: string; finalVerdict?: string }> = [];
  public sendResults: SendResult[] = [];
  public defaultSendResult: SendResult = {
    success: true,
    retriable: false,
    transportMessageId: 'tmsg',
  };
  public nextSendBehavior: 'ok' | 'retriable' | 'terminal' = 'ok';
  public retriableAttemptsLeft = 0;

  constructor(name = 'fake') {
    super();
    this.name = name;
  }

  override async start(_ctx: AdapterContext): Promise<void> {}
  override async stop(): Promise<void> {}
  override async sendOutbound(msg: OutboundMessage): Promise<SendResult> {
    this.sent.push(msg);
    if (this.nextSendBehavior === 'retriable') {
      if (this.retriableAttemptsLeft > 0) {
        this.retriableAttemptsLeft--;
        const res: SendResult = { success: false, retriable: true, error: 'transient' };
        this.sendResults.push(res);
        return res;
      }
      this.nextSendBehavior = 'ok';
    }
    if (this.nextSendBehavior === 'terminal') {
      const res: SendResult = { success: false, retriable: false, error: 'terminal error' };
      this.sendResults.push(res);
      return res;
    }
    this.sendResults.push(this.defaultSendResult);
    return this.defaultSendResult;
  }
  override async sendPermissionPrompt(prompt: PermissionPrompt): Promise<void> {
    this.prompts.push(prompt);
  }
  override async cancelPermissionPrompt(requestId: string, finalVerdict?: string): Promise<void> {
    this.canceled.push(finalVerdict !== undefined ? { requestId, finalVerdict } : { requestId });
  }
}
