import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';

export interface PortStatus {
  p1_active: boolean;
  p2_active: boolean;
  p1_remaining?: number;
  p2_remaining?: number;
  availablePorts: number[];
  availableCount: number;
  brokerConnected: boolean;
  deviceOnline: boolean;
  statusReceived: boolean;
  statusAgeMs?: number;
  lastUpdatedAt?: string;
}

const DEVICE_STATUS_TTL_MS = 6500;

type CardScannedHandler = (cardUid: string) => Promise<void> | void;
type DevicePortSelectedHandler = (
  cardUid: string,
  port: number,
  action: string,
) => Promise<void> | void;
type PortPausedHandler = (
  port: number,
  remainingMs: number,
) => Promise<void> | void;
type PortCompletedHandler = (port: number) => Promise<void> | void;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client!: mqtt.MqttClient;
  private readonly cardScannedHandlers = new Set<CardScannedHandler>();
  private readonly devicePortSelectedHandlers =
    new Set<DevicePortSelectedHandler>();
  private readonly portPausedHandlers = new Set<PortPausedHandler>();
  private readonly portCompletedHandlers = new Set<PortCompletedHandler>();
  private readonly recentlyPausedPorts = new Set<number>();
  private portStatus: PortStatus = {
    p1_active: false,
    p2_active: false,
    availablePorts: [],
    availableCount: 0,
    brokerConnected: false,
    deviceOnline: false,
    statusReceived: false,
  };

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    // 3. Use this.configService.get() instead of process.env
    const host = this.configService.get<string>('MQTT_HOST', 'localhost');
    const port = this.configService.get<number>('MQTT_PORT', 1883);
    const username = this.configService.get<string>('MQTT_USER');
    const password = this.configService.get<string>('MQTT_PASS');

    this.logger.log(
      `Connecting to MQTT broker at ${host}:${port} with user ${username || 'anonymous'}`,
    );

    this.client = mqtt.connect(`mqtt://${host}:${port}`, {
      username,
      password,
      reconnectPeriod: 5000,
      clientId: `spark-backend-${Date.now()}`,
    });

    this.client.on('connect', () => {
      this.portStatus = {
        ...this.portStatus,
        brokerConnected: true,
      };

      this.client.subscribe(
        ['device/status', 'device/command', 'device/identify'],
        (err) => {
          if (err) {
            this.logger.error(`MQTT subscribe error: ${err.message}`);
            return;
          }

          this.logger.log(
            'Subscribed to device/status, device/command, and device/identify',
          );
        },
      );
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });

    this.client.on('close', () => {
      this.portStatus = {
        ...this.portStatus,
        brokerConnected: false,
      };
    });

    this.client.on('reconnect', () => {
      this.portStatus = {
        ...this.portStatus,
        brokerConnected: false,
      };
    });

    // Error handling to help you debug connection issues
    this.client.on('error', (err) => {
      this.portStatus = {
        ...this.portStatus,
        brokerConnected: false,
      };
      this.logger.error(`MQTT connection error: ${err.message}`);
    });
  }

  onModuleDestroy() {
    this.client?.end();
  }

  publish(topic: string, payload: object): void {
    if (!this.client?.connected) {
      this.logger.warn('MQTT client not connected, cannot publish');
      return;
    }
    this.client.publish(topic, JSON.stringify(payload));
  }

  getPortStatus(): PortStatus {
    const brokerConnected = this.client?.connected ?? false;
    const statusAgeMs = this.getStatusAgeMs(this.portStatus.lastUpdatedAt);
    const statusFresh =
      this.portStatus.statusReceived &&
      statusAgeMs !== undefined &&
      statusAgeMs <= DEVICE_STATUS_TTL_MS;

    return {
      ...this.portStatus,
      p1_remaining: this.getAdjustedRemaining(
        this.portStatus.p1_active,
        this.portStatus.p1_remaining,
        statusAgeMs,
      ),
      p2_remaining: this.getAdjustedRemaining(
        this.portStatus.p2_active,
        this.portStatus.p2_remaining,
        statusAgeMs,
      ),
      brokerConnected,
      deviceOnline: brokerConnected && statusFresh,
      statusAgeMs,
    };
  }

  onCardScanned(handler: CardScannedHandler) {
    this.cardScannedHandlers.add(handler);
  }

  onDevicePortSelected(handler: DevicePortSelectedHandler) {
    this.devicePortSelectedHandlers.add(handler);
  }

  onPortPaused(handler: PortPausedHandler) {
    this.portPausedHandlers.add(handler);
  }

  onPortCompleted(handler: PortCompletedHandler) {
    this.portCompletedHandlers.add(handler);
  }

  private handleMessage(topic: string, payload: Buffer) {
    if (topic === 'device/identify') {
      const cardUid = this.extractCardUid(payload);
      console.log(`Received identify message with card UID: ${cardUid}`);
      if (cardUid) {
        this.notifyCardScanned(cardUid);
      }
      return;
    }

    try {
      const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;

      if (topic === 'device/status') {
        const previousStatus = this.portStatus;
        const p1Active = this.toBoolean(parsed.p1_active);
        const p2Active = this.toBoolean(parsed.p2_active);
        const p1ReportedRemaining = this.toOptionalNumber(
          parsed.p1_remaining ?? parsed.p1_remain,
        );
        const p2ReportedRemaining = this.toOptionalNumber(
          parsed.p2_remaining ?? parsed.p2_remain,
        );
        const nextStatus: PortStatus = {
          p1_active: p1Active,
          p2_active: p2Active,
          p1_remaining: p1Active
            ? p1ReportedRemaining
            : (p1ReportedRemaining ??
              (previousStatus.p1_active
                ? undefined
                : previousStatus.p1_remaining)),
          p2_remaining: p2Active
            ? p2ReportedRemaining
            : (p2ReportedRemaining ??
              (previousStatus.p2_active
                ? undefined
                : previousStatus.p2_remaining)),
          availablePorts: [],
          availableCount: 0,
          brokerConnected: this.client?.connected ?? false,
          deviceOnline: this.client?.connected ?? false,
          statusReceived: true,
          lastUpdatedAt: new Date().toISOString(),
        };

        nextStatus.availablePorts = [1, 2].filter((port) =>
          port === 1 ? !nextStatus.p1_active : !nextStatus.p2_active,
        );
        nextStatus.availableCount = nextStatus.availablePorts.length;
        this.portStatus = nextStatus;

        this.handlePortStateTransition(previousStatus, nextStatus, 1);
        this.handlePortStateTransition(previousStatus, nextStatus, 2);
        return;
      }

      if (topic === 'device/command' && parsed.event === 'time_paused') {
        const port = this.toOptionalNumber(parsed.port);
        const remainingMs = this.toOptionalNumber(parsed.remaining_ms);

        if (!port || remainingMs === undefined) {
          return;
        }

        this.recentlyPausedPorts.add(port);

        if (port === 1) {
          this.portStatus = {
            ...this.portStatus,
            p1_active: false,
            p1_remaining: remainingMs,
            availablePorts: this.getAvailablePorts(
              false,
              this.portStatus.p2_active,
            ),
            availableCount: this.getAvailablePorts(
              false,
              this.portStatus.p2_active,
            ).length,
            lastUpdatedAt: new Date().toISOString(),
          };
        }

        if (port === 2) {
          this.portStatus = {
            ...this.portStatus,
            p2_active: false,
            p2_remaining: remainingMs,
            availablePorts: this.getAvailablePorts(
              this.portStatus.p1_active,
              false,
            ),
            availableCount: this.getAvailablePorts(
              this.portStatus.p1_active,
              false,
            ).length,
            lastUpdatedAt: new Date().toISOString(),
          };
        }

        this.notifyPortPaused(port, remainingMs);
        return;
      }

      if (topic === 'device/command' && parsed.event === 'port_selected') {
        const cardUid = this.extractCardUid(payload);
        const port = this.toOptionalNumber(parsed.port);
        const action = this.toOptionalString(parsed.action) ?? 'resume';

        if (!cardUid || !port) {
          return;
        }

        this.notifyDevicePortSelected(cardUid, port, action);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown MQTT parse error';
      this.logger.warn(`Ignoring invalid MQTT payload on ${topic}: ${message}`);
    }
  }

  private toBoolean(value: unknown): boolean {
    return value === true;
  }

  private toOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  private toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  private getAvailablePorts(p1Active: boolean, p2Active: boolean): number[] {
    return [1, 2].filter((port) => (port === 1 ? !p1Active : !p2Active));
  }

  private getStatusAgeMs(lastUpdatedAt?: string): number | undefined {
    if (!lastUpdatedAt) {
      return undefined;
    }

    const lastUpdatedTs = Date.parse(lastUpdatedAt);
    if (Number.isNaN(lastUpdatedTs)) {
      return undefined;
    }

    return Math.max(0, Date.now() - lastUpdatedTs);
  }

  private getAdjustedRemaining(
    isActive: boolean,
    remainingMs?: number,
    statusAgeMs?: number,
  ): number | undefined {
    if (remainingMs === undefined) {
      return undefined;
    }

    if (!isActive || statusAgeMs === undefined) {
      return remainingMs;
    }

    return Math.max(0, remainingMs - statusAgeMs);
  }

  sendNewSession(port: number, timeMs: number): void {
    this.publish('device/command', {
      cmd: 'new-session',
      port,
      duration_ms: timeMs,
    });
    this.logger.log(`Sent new-session to port ${port} for ${timeMs}ms`);
  }

  sendPause(port: number): void {
    this.publish('device/command', { cmd: 'pause', port });
    this.logger.log(`Sent pause to port ${port}`);
  }

  sendResume(port: number, remainingMs: number): void {
    this.publish('device/command', {
      cmd: 'resume',
      port,
      remaining_ms: remainingMs,
    });
    this.logger.log(`Sent resume to port ${port} with ${remainingMs}ms`);
  }

  sendDeviceMessage(line1: string, line2 = '', durationMs = 3500): void {
    this.publish('device/command', {
      cmd: 'display-message',
      line1,
      line2,
      duration_ms: durationMs,
    });
  }

  promptDevicePortSelection(cardUid: string, action: 'resume' | 'start') {
    this.publish('device/command', {
      cmd: 'select-port',
      action,
      card_uid: cardUid,
    });
  }

  private extractCardUid(payload: Buffer): string | undefined {
    const rawPayload = payload.toString().trim();
    if (!rawPayload) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
      const cardUid = parsed.card_uid ?? parsed.cardUid ?? parsed.uid;
      return typeof cardUid === 'string'
        ? cardUid.trim().toUpperCase()
        : undefined;
    } catch {
      return rawPayload.toUpperCase();
    }
  }

  private handlePortStateTransition(
    previousStatus: PortStatus,
    nextStatus: PortStatus,
    port: 1 | 2,
  ) {
    const wasActive =
      port === 1 ? previousStatus.p1_active : previousStatus.p2_active;
    const isActive = port === 1 ? nextStatus.p1_active : nextStatus.p2_active;

    if (!wasActive || isActive) {
      return;
    }

    if (this.recentlyPausedPorts.delete(port)) {
      return;
    }

    this.notifyPortCompleted(port);
  }

  private notifyCardScanned(cardUid: string) {
    for (const handler of this.cardScannedHandlers) {
      void Promise.resolve(handler(cardUid)).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Unknown handler error';
        this.logger.warn(`Card scan handler failed: ${message}`);
      });
    }
  }

  private notifyDevicePortSelected(
    cardUid: string,
    port: number,
    action: string,
  ) {
    for (const handler of this.devicePortSelectedHandlers) {
      void Promise.resolve(handler(cardUid, port, action)).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Unknown handler error';
          this.logger.warn(`Device port selection handler failed: ${message}`);
        },
      );
    }
  }

  private notifyPortPaused(port: number, remainingMs: number) {
    for (const handler of this.portPausedHandlers) {
      void Promise.resolve(handler(port, remainingMs)).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Unknown handler error';
          this.logger.warn(`Pause handler failed: ${message}`);
        },
      );
    }
  }

  private notifyPortCompleted(port: number) {
    for (const handler of this.portCompletedHandlers) {
      void Promise.resolve(handler(port)).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Unknown handler error';
        this.logger.warn(`Completion handler failed: ${message}`);
      });
    }
  }
}
