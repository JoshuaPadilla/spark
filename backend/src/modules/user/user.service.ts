import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { PendingSessionAction, User } from './entity/user.entity';

const SALT_ROUNDS = 10;

interface PendingSessionInput {
  action: PendingSessionAction;
  port: number;
  durationMs: number;
  message: string;
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { username } });
  }

  async findById(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByCardUid(cardUid: string): Promise<User | null> {
    const normalizedCardUid = this.normalizeCardUid(cardUid);
    if (!normalizedCardUid) return null;

    const userFromArray = await this.userRepo
      .createQueryBuilder('user')
      .where('user."cardUids" @> CAST(:cardUids AS jsonb)', {
        cardUids: JSON.stringify([normalizedCardUid]),
      })
      .getOne();

    if (userFromArray) {
      return userFromArray;
    }

    return this.userRepo.findOne({ where: { cardUid: normalizedCardUid } });
  }

  async findByActivePort(port: number): Promise<User | null> {
    if (port !== 1 && port !== 2) return null;
    return this.userRepo
      .createQueryBuilder('user')
      .where('(user.activePort & :portMask) != 0', { portMask: port })
      .getOne();
  }

  async findUsersByActivePort(port: number): Promise<User[]> {
    if (port !== 1 && port !== 2) return [];
    return this.userRepo
      .createQueryBuilder('user')
      .where('(user.activePort & :portMask) != 0', { portMask: port })
      .getMany();
  }

  async create(username: string, plainPassword: string): Promise<User> {
    const existing = await this.findByUsername(username);
    if (existing) throw new ConflictException('Username already taken');

    const password = await bcrypt.hash(plainPassword, SALT_ROUNDS);
    const user = this.userRepo.create({
      username,
      password,
      balance: 0,
      cardUid: null,
      cardUids: [],
      timeRemaining: 0,
      lastPortConnected: 0,
      activePort: 0,
      pendingAction: null,
      pendingPort: 0,
      pendingDurationMs: 0,
      pendingMessage: null,
    });
    return this.userRepo.save(user);
  }

  async updateCardUid(userId: string, cardUid: string | null): Promise<User> {
    const user = await this.findById(userId);
    const normalizedCardUid = this.normalizeCardUid(cardUid);
    const currentCards = this.getNormalizedCardUids(user);

    if (normalizedCardUid) {
      const existing = await this.userRepo
        .createQueryBuilder('user')
        .where('user.id != :userId', { userId })
        .andWhere(
          '(user."cardUid" = :cardUid OR user."cardUids" @> CAST(:cardUids AS jsonb))',
          {
            cardUid: normalizedCardUid,
            cardUids: JSON.stringify([normalizedCardUid]),
          },
        )
        .getOne();

      if (existing) {
        throw new ConflictException(
          'Card UID is already linked to another user',
        );
      }

      if (!currentCards.includes(normalizedCardUid)) {
        currentCards.push(normalizedCardUid);
      }

      user.cardUids = currentCards;
      user.cardUid = currentCards[0] ?? normalizedCardUid;
      user.pendingMessage = `Card ${normalizedCardUid} linked successfully. ${currentCards.length} linked card(s) on your account.`;
      return this.userRepo.save(user);
    }

    user.cardUid = null;
    user.cardUids = [];
    user.pendingMessage = 'All linked card UIDs were removed.';
    return this.userRepo.save(user);
  }

  async addBalance(userId: string, amount: number): Promise<User> {
    const user = await this.findById(userId);
    user.balance = user.balance + amount;
    return this.userRepo.save(user);
  }

  async deductBalance(userId: string, amount: number): Promise<User> {
    const user = await this.findById(userId);
    if (user.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }
    user.balance = user.balance - amount;
    return this.userRepo.save(user);
  }

  async setPendingSession(
    userId: string,
    { action, port, durationMs, message }: PendingSessionInput,
  ): Promise<User> {
    const user = await this.findById(userId);
    user.pendingAction = action;
    user.pendingPort = port;
    user.pendingDurationMs = durationMs;
    user.pendingMessage = message;
    return this.userRepo.save(user);
  }

  async clearPendingSession(userId: string, message: string): Promise<User> {
    const user = await this.findById(userId);
    user.pendingAction = null;
    user.pendingPort = 0;
    user.pendingDurationMs = 0;
    user.pendingMessage = message;
    return this.userRepo.save(user);
  }

  async markSessionActive(
    userId: string,
    port: number,
    message: string,
  ): Promise<User> {
    const retainedMask = port === 1 ? 2 : 1;

    await this.userRepo
      .createQueryBuilder()
      .update(User)
      .set({
        activePort: () => `"activePort" & ${retainedMask}`,
        pendingAction: null,
        pendingPort: 0,
        pendingDurationMs: 0,
        pendingMessage: `Session ownership on Port ${port} was reassigned to another user.`,
      })
      .where('("activePort" & :portMask) != 0', { portMask: port })
      .andWhere('id != :userId', { userId })
      .execute();

    const user = await this.findById(userId);
    user.activePort = this.addPortToMask(user.activePort, port);
    user.lastPortConnected = port;
    user.timeRemaining = 0;
    user.pendingAction = null;
    user.pendingPort = 0;
    user.pendingDurationMs = 0;
    user.pendingMessage = message;
    return this.userRepo.save(user);
  }

  async savePausedSession(
    userId: string,
    port: number,
    remainingMs: number,
    message: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    user.activePort = this.removePortFromMask(user.activePort, port);
    user.lastPortConnected = port;
    user.timeRemaining =
      Math.max(0, user.timeRemaining) + Math.max(0, remainingMs);
    user.pendingAction = null;
    user.pendingPort = 0;
    user.pendingDurationMs = 0;
    user.pendingMessage = message;
    return this.userRepo.save(user);
  }

  async clearCompletedSession(
    userId: string,
    message: string,
    port?: number,
  ): Promise<User> {
    const user = await this.findById(userId);

    if (port === 1 || port === 2) {
      user.activePort = this.removePortFromMask(user.activePort, port);
      user.lastPortConnected = port;
    } else {
      user.activePort = 0;
      user.timeRemaining = 0;
    }

    user.pendingAction = null;
    user.pendingPort = 0;
    user.pendingDurationMs = 0;
    user.pendingMessage = message;
    return this.userRepo.save(user);
  }

  // Returns user without the password field
  sanitize(user: User): Omit<User, 'password'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _pw, ...rest } = user;
    return rest;
  }

  private normalizeCardUid(cardUid: string | null | undefined): string | null {
    if (typeof cardUid !== 'string') return null;

    const normalizedCardUid = cardUid.trim().replace(/\s+/g, '').toUpperCase();
    return normalizedCardUid.length > 0 ? normalizedCardUid : null;
  }

  private getNormalizedCardUids(user: User): string[] {
    const cards = new Set<string>();

    if (Array.isArray(user.cardUids)) {
      for (const card of user.cardUids) {
        const normalized = this.normalizeCardUid(card);
        if (normalized) {
          cards.add(normalized);
        }
      }
    }

    const primaryCard = this.normalizeCardUid(user.cardUid);
    if (primaryCard) {
      cards.add(primaryCard);
    }

    return [...cards];
  }

  private addPortToMask(activePort: number, port: number) {
    return activePort | port;
  }

  private removePortFromMask(activePort: number, port: number) {
    return activePort & ~port;
  }
}
