import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { MqttService } from '../mqtt/mqtt.service';
import { UserService } from '../user/user.service';

/** Minutes → pesos cost map. Adjust pricing as needed. */
const DURATION_COSTS: Record<number, number> = {
  1: 1,
  5: 5,
  10: 10,
  20: 20,
};

const CARD_ONLY_START_MINUTES = 20;
const CARD_ONLY_START_DURATION_MS = CARD_ONLY_START_MINUTES * 60 * 1000;

@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly userService: UserService,
    private readonly mqttService: MqttService,
  ) {}

  onModuleInit() {
    this.mqttService.onCardScanned(
      (cardUid) => void this.handleCardScan(cardUid),
    );
    this.mqttService.onDevicePortSelected(
      (cardUid, port, action) =>
        void this.handleDevicePortSelection(cardUid, port, action),
    );
    this.mqttService.onPortPaused(
      (port, remainingMs) => void this.handlePortPaused(port, remainingMs),
    );
    this.mqttService.onPortCompleted(
      (port) => void this.handlePortCompleted(port),
    );
  }

  async getStatus(userId?: string) {
    const status = this.mqttService.getPortStatus();

    if (userId) {
      await this.reconcileUserSessionState(userId, status);
    }

    return status;
  }

  async startSession(userId: string, port: number, minutes: number) {
    this.assertValidPort(port);
    const cost = DURATION_COSTS[minutes];
    if (cost === undefined) {
      throw new BadRequestException(
        'Invalid duration. Allowed: 1, 5, 10, 20 minutes',
      );
    }

    const user = await this.userService.findById(userId);
    this.assertCanClaimPort(user.activePort, port);
    this.assertNoSavedTimeConflict(user.timeRemaining);
    this.assertSufficientBalance(user.balance, cost);
    const status = this.assertDeviceReady();
    this.assertPortAvailable(status.availablePorts, port);

    const durationMs = minutes * 60 * 1000;
    await this.userService.deductBalance(userId, cost);
    this.mqttService.sendNewSession(port, durationMs);
    await this.userService.markSessionActive(
      userId,
      port,
      `Charging started on Port ${port}.`,
    );

    return {
      success: true,
      pending: false,
      port,
      minutes,
      cost,
      message: `Charging started on Port ${port}.`,
    };
  }

  async pauseSession(userId: string, requestedPort?: number) {
    const user = await this.userService.findById(userId);
    const port = this.getOwnedPortForPause(user.activePort, requestedPort);
    await this.assertPauseOwnership(userId, port);
    const status = this.assertDeviceReady();
    this.assertPortBusy(status.availablePorts, port);
    const remainingMs = port === 1 ? status.p1_remaining : status.p2_remaining;

    this.mqttService.sendPause(port);

    if (remainingMs !== undefined) {
      await this.userService.savePausedSession(
        userId,
        port,
        remainingMs,
        `Port ${port} paused. ${this.formatDuration(remainingMs)} saved for resume.`,
      );
    }

    return { success: true, port, remainingMs };
  }

  async resumeSession(userId: string, port: number) {
    this.assertValidPort(port);
    const user = await this.userService.findById(userId);
    this.assertCanClaimPort(user.activePort, port);

    if (user.timeRemaining <= 0) {
      throw new BadRequestException('No paused session available to resume');
    }

    const status = this.assertDeviceReady();
    this.assertPortAvailable(status.availablePorts, port);

    this.mqttService.sendResume(port, user.timeRemaining);
    await this.userService.markSessionActive(
      userId,
      port,
      `Charging resumed on Port ${port}.`,
    );

    return {
      success: true,
      pending: false,
      port,
      remainingMs: user.timeRemaining,
      message: `Charging resumed on Port ${port}.`,
    };
  }

  private async handleCardScan(cardUid: string) {
    const user = await this.userService.findByCardUid(cardUid);

    if (!user) {
      this.logger.warn(`Ignoring scan for unlinked card ${cardUid}`);
      this.mqttService.sendDeviceMessage('UNKNOWN CARD', 'NOT LINKED');
      return;
    }

    if (
      !user.pendingAction ||
      user.pendingPort === 0 ||
      user.pendingDurationMs <= 0
    ) {
      await this.handleCardScanWithoutPendingSelection(user.id, cardUid);
      return;
    }

    const port = user.pendingPort;
    const status = this.mqttService.getPortStatus();
    if (!status.deviceOnline) {
      await this.userService.clearPendingSession(
        user.id,
        'Device status is offline or stale. Try again when the charger sends a fresh update.',
      );
      this.mqttService.sendDeviceMessage('DEVICE OFFLINE', 'TRY AGAIN');
      return;
    }

    if (!status.availablePorts.includes(port)) {
      await this.userService.clearPendingSession(
        user.id,
        `Port ${port} is busy now. Pick another port and try again.`,
      );
      this.mqttService.sendDeviceMessage('PORT BUSY', `PORT ${port}`);
      return;
    }

    if (user.pendingAction === 'start') {
      const minutes = user.pendingDurationMs / (60 * 1000);
      const cost = DURATION_COSTS[minutes];
      if (cost === undefined) {
        await this.userService.clearPendingSession(
          user.id,
          'Unsupported session duration. Please choose a valid duration again.',
        );
        this.mqttService.sendDeviceMessage('INVALID PLAN', 'TRY AGAIN');
        return;
      }

      if (user.balance < cost) {
        await this.userService.clearPendingSession(
          user.id,
          `Insufficient balance. Need ₱${cost}, current balance: ₱${user.balance}`,
        );
        this.mqttService.sendDeviceMessage('NO BALANCE', 'TOP UP FIRST');
        return;
      }

      await this.userService.deductBalance(user.id, cost);
      this.mqttService.sendNewSession(port, user.pendingDurationMs);
      await this.userService.markSessionActive(
        user.id,
        port,
        `Charging started on Port ${port}.`,
      );
      return;
    }

    if (user.timeRemaining <= 0) {
      await this.userService.clearPendingSession(
        user.id,
        'No saved charging time is available to resume.',
      );
      this.mqttService.sendDeviceMessage('NO SAVED TIME', 'SELECT IN APP');
      return;
    }

    this.mqttService.sendResume(port, user.pendingDurationMs);
    await this.userService.markSessionActive(
      user.id,
      port,
      `Charging resumed on Port ${port}.`,
    );
  }

  private async handleCardScanWithoutPendingSelection(
    userId: string,
    cardUid: string,
  ) {
    const user = await this.userService.findById(userId);

    if (this.getOwnedPorts(user.activePort).length === 2) {
      this.mqttService.sendDeviceMessage(
        'ALL PORTS ACTIVE',
        'WAIT FOR FREE PORT',
      );
      return;
    }

    if (user.timeRemaining > 0) {
      let status;
      try {
        status = this.assertDeviceReady();
      } catch {
        await this.userService.clearPendingSession(
          user.id,
          'Device status is offline or stale. Try again when the charger sends a fresh update.',
        );
        this.mqttService.sendDeviceMessage('DEVICE OFFLINE', 'TRY AGAIN');
        return;
      }

      if (status.availableCount === 0) {
        await this.userService.clearPendingSession(
          user.id,
          'All charging ports are currently busy. Try again when a port becomes available.',
        );
        this.mqttService.sendDeviceMessage('ALL PORTS BUSY', 'TRY LATER');
        return;
      }

      await this.userService.setPendingSession(user.id, {
        action: 'resume',
        port: 0,
        durationMs: user.timeRemaining,
        message:
          'Select a port on the device buttons to resume your saved time.',
      });
      this.mqttService.promptDevicePortSelection(cardUid, 'resume');
      return;
    }

    if (user.balance < DURATION_COSTS[CARD_ONLY_START_MINUTES]) {
      await this.userService.clearPendingSession(
        user.id,
        'Insufficient balance. Top up your wallet before starting a charge.',
      );
      this.mqttService.sendDeviceMessage('NO BALANCE', 'TOP UP FIRST');
      return;
    }

    let status;
    try {
      status = this.assertDeviceReady();
    } catch {
      await this.userService.clearPendingSession(
        user.id,
        'Device status is offline or stale. Try again when the charger sends a fresh update.',
      );
      this.mqttService.sendDeviceMessage('DEVICE OFFLINE', 'TRY AGAIN');
      return;
    }

    if (status.availableCount === 0) {
      await this.userService.clearPendingSession(
        user.id,
        'All charging ports are currently busy. Try again when a port becomes available.',
      );
      this.mqttService.sendDeviceMessage('ALL PORTS BUSY', 'TRY LATER');
      return;
    }

    await this.userService.setPendingSession(user.id, {
      action: 'start',
      port: 0,
      durationMs: CARD_ONLY_START_DURATION_MS,
      message:
        'Select a port on the device buttons to start the default 20-minute charge.',
    });
    this.mqttService.promptDevicePortSelection(cardUid, 'start');
  }

  private async handleDevicePortSelection(
    cardUid: string,
    port: number,
    action: string,
  ) {
    this.assertValidPort(port);

    const user = await this.userService.findByCardUid(cardUid);
    if (!user) {
      this.mqttService.sendDeviceMessage('UNKNOWN CARD', 'NOT LINKED');
      return;
    }

    if (this.userOwnsPort(user.activePort, port)) {
      this.mqttService.sendDeviceMessage('SESSION ACTIVE', `PORT ${port}`);
      return;
    }

    let status;
    try {
      status = this.assertDeviceReady();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Device status is offline or stale';

      await this.userService.clearPendingSession(user.id, message);
      this.mqttService.sendDeviceMessage('DEVICE OFFLINE', 'TRY AGAIN');
      return;
    }

    if (!status.availablePorts.includes(port)) {
      await this.userService.clearPendingSession(
        user.id,
        `Port ${port} is busy now. Choose another available port to continue.`,
      );
      this.mqttService.sendDeviceMessage('PORT BUSY', `PORT ${port}`);
      return;
    }

    if (action === 'resume' || user.timeRemaining > 0) {
      const remainingMs =
        user.pendingAction === 'resume' && user.pendingDurationMs > 0
          ? user.pendingDurationMs
          : user.timeRemaining;

      if (remainingMs <= 0) {
        await this.userService.clearPendingSession(
          user.id,
          'No saved charging time is available to resume.',
        );
        this.mqttService.sendDeviceMessage('NO SAVED TIME', 'SELECT IN APP');
        return;
      }

      this.mqttService.sendResume(port, remainingMs);
      await this.userService.markSessionActive(
        user.id,
        port,
        `Charging resumed on Port ${port}.`,
      );
      return;
    }

    if (action === 'start' || user.pendingAction === 'start') {
      const durationMs =
        user.pendingDurationMs > 0
          ? user.pendingDurationMs
          : CARD_ONLY_START_DURATION_MS;
      const minutes = durationMs / (60 * 1000);
      const cost = DURATION_COSTS[minutes];

      if (cost === undefined) {
        await this.userService.clearPendingSession(
          user.id,
          'Unsupported session duration. Please choose a valid duration again.',
        );
        this.mqttService.sendDeviceMessage('INVALID PLAN', 'TRY AGAIN');
        return;
      }

      if (user.balance < cost) {
        await this.userService.clearPendingSession(
          user.id,
          `Insufficient balance. Need ₱${cost}, current balance: ₱${user.balance}`,
        );
        this.mqttService.sendDeviceMessage('NO BALANCE', 'TOP UP FIRST');
        return;
      }

      await this.userService.deductBalance(user.id, cost);
      this.mqttService.sendNewSession(port, durationMs);
      await this.userService.markSessionActive(
        user.id,
        port,
        `Charging started on Port ${port}.`,
      );
      return;
    }

    await this.userService.clearPendingSession(
      user.id,
      'No pending session was found for this card. Start from the dashboard or tap again.',
    );
    this.mqttService.sendDeviceMessage('NO SESSION', 'TAP AGAIN');
  }

  private async handlePortPaused(port: number, remainingMs: number) {
    const user = await this.userService.findByActivePort(port);
    if (!user) {
      if (!this.mqttService.isPauseTransitionInProgress(port)) {
        this.logger.debug(`Pause event for port ${port} has no active owner`);
      }
      return;
    }

    await this.userService.savePausedSession(
      user.id,
      port,
      remainingMs,
      `Port ${port} paused. ${this.formatDuration(remainingMs)} saved for resume.`,
    );
  }

  private async handlePortCompleted(port: number) {
    const user = await this.userService.findByActivePort(port);
    if (!user) {
      return;
    }

    await this.userService.clearCompletedSession(
      user.id,
      `Charging on Port ${port} completed.`,
    );
  }

  private assertValidPort(port: number) {
    if (port !== 1 && port !== 2) {
      throw new BadRequestException('Invalid port. Must be 1 or 2');
    }
  }

  private assertCanClaimPort(activePort: number, port: number) {
    if (this.userOwnsPort(activePort, port)) {
      throw new BadRequestException(
        `You already have an active session on Port ${port}`,
      );
    }
  }

  private getOwnedPortForPause(activePort: number, requestedPort?: number) {
    if (requestedPort === 1 || requestedPort === 2) {
      if (this.userOwnsPort(activePort, requestedPort)) {
        return requestedPort;
      }

      throw new BadRequestException(
        `You do not have an active session on Port ${requestedPort}`,
      );
    }

    const activePorts = this.getOwnedPorts(activePort);
    if (activePorts.length === 1) {
      return activePorts[0];
    }

    if (activePorts.length > 1) {
      throw new BadRequestException(
        'You have active sessions on multiple ports. Choose which port to pause.',
      );
    }

    throw new BadRequestException('You do not have an active session to pause');
  }

  private assertNoSavedTimeConflict(timeRemaining: number) {
    if (timeRemaining > 0) {
      throw new BadRequestException(
        'You already have saved charging time. Resume it before starting a new session.',
      );
    }
  }

  private assertSufficientBalance(balance: number, cost: number) {
    if (balance < cost) {
      throw new BadRequestException(
        `Insufficient balance. Need ₱${cost}, current balance: ₱${balance}`,
      );
    }
  }

  private assertDeviceReady() {
    const status = this.mqttService.getPortStatus();
    if (!status.brokerConnected) {
      throw new BadRequestException('Charging device is offline');
    }
    if (!status.statusReceived) {
      throw new BadRequestException(
        'Waiting for live device status. Try again in a moment.',
      );
    }
    if (!status.deviceOnline) {
      throw new BadRequestException(
        'Waiting for a fresh device status update. Try again in a moment.',
      );
    }
    return status;
  }

  private assertPortAvailable(availablePorts: number[], port: number) {
    if (!availablePorts.includes(port)) {
      throw new BadRequestException(
        `Port ${port} is currently busy. Choose another available port.`,
      );
    }
  }

  private assertPortBusy(availablePorts: number[], port: number) {
    if (availablePorts.includes(port)) {
      throw new BadRequestException(
        `Port ${port} is not currently in use. Refresh the dashboard and choose an active session instead.`,
      );
    }
  }

  private formatDuration(durationMs: number) {
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private async assertPauseOwnership(userId: string, port: number) {
    const owners = await this.userService.findUsersByActivePort(port);

    if (owners.length !== 1 || owners[0]?.id !== userId) {
      throw new BadRequestException(
        `You cannot pause Port ${port} because it is owned by another user.`,
      );
    }
  }

  private async reconcileUserSessionState(
    userId: string,
    status: ReturnType<MqttService['getPortStatus']>,
  ) {
    if (!status.deviceOnline) {
      return;
    }

    const user = await this.userService.findById(userId);
    const activePorts = this.getOwnedPorts(user.activePort);

    if (activePorts.length === 0) {
      return;
    }

    for (const activePort of activePorts) {
      const portIsActive =
        activePort === 1 ? status.p1_active : status.p2_active;
      if (portIsActive) {
        continue;
      }

      if (this.mqttService.isActivationTransitionInProgress(activePort)) {
        continue;
      }

      if (this.mqttService.isPauseTransitionInProgress(activePort)) {
        continue;
      }

      this.logger.warn(
        `Clearing stale active session for user ${userId} on port ${activePort}; fresh device status reports the port is inactive.`,
      );
      await this.userService.clearCompletedSession(
        userId,
        `Session on Port ${activePort} was cleared because the charger reports that port is no longer active.`,
        activePort,
      );
    }
  }

  private getOwnedPorts(activePort: number): Array<1 | 2> {
    const ports: Array<1 | 2> = [];

    if ((activePort & 1) !== 0) {
      ports.push(1);
    }

    if ((activePort & 2) !== 0) {
      ports.push(2);
    }

    return ports;
  }

  private userOwnsPort(activePort: number, port: number) {
    return (activePort & port) !== 0;
  }
}
