import { ConfigService } from '@nestjs/config';
import { MqttService } from './mqtt.service';

describe('MqttService', () => {
  let service: MqttService;

  beforeEach(() => {
    service = new MqttService({
      get: jest.fn(),
    } as unknown as ConfigService);
    (
      service as unknown as {
        client: { connected: boolean; publish: jest.Mock };
      }
    ).client = {
      connected: true,
      publish: jest.fn(),
    };
  });

  it('treats an active-to-inactive transition after a pause request as paused instead of completed', () => {
    const pausedHandler = jest.fn();
    const completedHandler = jest.fn();

    service.onPortPaused(pausedHandler);
    service.onPortCompleted(completedHandler);
    (
      service as unknown as {
        portStatus: {
          availableCount: number;
          availablePorts: number[];
          brokerConnected: boolean;
          deviceOnline: boolean;
          lastUpdatedAt: string;
          p1_active: boolean;
          p1_remaining: number;
          p2_active: boolean;
          statusReceived: boolean;
        };
      }
    ).portStatus = {
      availableCount: 1,
      availablePorts: [2],
      brokerConnected: true,
      deviceOnline: true,
      lastUpdatedAt: new Date().toISOString(),
      p1_active: true,
      p1_remaining: 60000,
      p2_active: false,
      statusReceived: true,
    };

    service.sendPause(1);
    (
      service as unknown as {
        handleMessage: (topic: string, payload: Buffer) => void;
      }
    ).handleMessage(
      'device/status',
      Buffer.from(JSON.stringify({ p1_active: false, p2_active: false })),
    );

    expect(pausedHandler).toHaveBeenCalledWith(1, 60000);
    expect(completedHandler).not.toHaveBeenCalled();
  });

  it('reports a just-paused port as available before the device status catches up', () => {
    (
      service as unknown as {
        portStatus: {
          availableCount: number;
          availablePorts: number[];
          brokerConnected: boolean;
          deviceOnline: boolean;
          lastUpdatedAt: string;
          p1_active: boolean;
          p1_remaining: number;
          p2_active: boolean;
          p2_remaining: number;
          statusReceived: boolean;
        };
      }
    ).portStatus = {
      availableCount: 1,
      availablePorts: [2],
      brokerConnected: true,
      deviceOnline: true,
      lastUpdatedAt: new Date().toISOString(),
      p1_active: true,
      p1_remaining: 60000,
      p2_active: false,
      p2_remaining: 0,
      statusReceived: true,
    };

    service.sendPause(1);

    expect(service.getPortStatus()).toEqual(
      expect.objectContaining({
        availableCount: 2,
        availablePorts: [1, 2],
        p1_active: false,
      }),
    );
  });
});
