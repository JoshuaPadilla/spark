import { MqttService } from '../mqtt/mqtt.service';
import { UserService } from '../user/user.service';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  let service: SessionsService;
  let userService: {
    clearCompletedSession: jest.Mock;
    deductBalance: jest.Mock;
    findById: jest.Mock;
    findUsersByActivePort: jest.Mock;
    markSessionActive: jest.Mock;
    savePausedSession: jest.Mock;
    setPendingSession: jest.Mock;
  };
  let mqttService: {
    getPortStatus: jest.Mock;
    isPauseTransitionInProgress: jest.Mock;
    sendNewSession: jest.Mock;
    sendPause: jest.Mock;
  };

  beforeEach(() => {
    userService = {
      clearCompletedSession: jest.fn(),
      deductBalance: jest.fn(),
      findById: jest.fn(),
      findUsersByActivePort: jest.fn(),
      markSessionActive: jest.fn(),
      savePausedSession: jest.fn(),
      setPendingSession: jest.fn(),
    };
    mqttService = {
      getPortStatus: jest.fn(),
      isPauseTransitionInProgress: jest.fn().mockReturnValue(false),
      sendNewSession: jest.fn(),
      sendPause: jest.fn(),
    };

    service = new SessionsService(
      userService as unknown as UserService,
      mqttService as unknown as MqttService,
    );
  });

  it('starts dashboard sessions immediately without requiring a card tap', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      activePort: 0,
      balance: 25,
      cardUid: null,
      timeRemaining: 0,
    });
    mqttService.getPortStatus.mockReturnValue({
      availablePorts: [1, 2],
      brokerConnected: true,
      deviceOnline: true,
      p1_active: false,
      p2_active: false,
      statusReceived: true,
    });

    const result = await service.startSession('user-1', 1, 5);

    expect(userService.deductBalance).toHaveBeenCalledWith('user-1', 5);
    expect(mqttService.sendNewSession).toHaveBeenCalledWith(1, 5 * 60 * 1000);
    expect(userService.markSessionActive).toHaveBeenCalledWith(
      'user-1',
      1,
      'Charging started on Port 1.',
    );
    expect(userService.setPendingSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      pending: false,
      port: 1,
      minutes: 5,
      cost: 5,
      message: 'Charging started on Port 1.',
    });
  });

  it('does not clear a session while a pause transition is still settling', async () => {
    mqttService.getPortStatus.mockReturnValue({
      availableCount: 2,
      availablePorts: [1, 2],
      brokerConnected: true,
      deviceOnline: true,
      p1_active: false,
      p2_active: false,
      statusReceived: true,
    });
    mqttService.isPauseTransitionInProgress.mockReturnValue(true);
    userService.findById.mockResolvedValue({
      activePort: 1,
      id: 'user-1',
    });

    await service.getStatus('user-1');

    expect(userService.clearCompletedSession).not.toHaveBeenCalled();
  });

  it('saves paused time immediately from the live status snapshot', async () => {
    userService.findById.mockResolvedValue({
      activePort: 1,
      id: 'user-1',
    });
    userService.findUsersByActivePort.mockResolvedValue([{ id: 'user-1' }]);
    mqttService.getPortStatus.mockReturnValue({
      availableCount: 1,
      availablePorts: [2],
      brokerConnected: true,
      deviceOnline: true,
      p1_active: true,
      p1_remaining: 47000,
      p2_active: false,
      statusReceived: true,
    });

    const result = await service.pauseSession('user-1');

    expect(mqttService.sendPause).toHaveBeenCalledWith(1);
    expect(userService.savePausedSession).toHaveBeenCalledWith(
      'user-1',
      1,
      47000,
      'Port 1 paused. 0:47 saved for resume.',
    );
    expect(result).toEqual({ success: true, port: 1, remainingMs: 47000 });
  });
});
