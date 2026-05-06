import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type PendingSessionAction = 'start' | 'resume';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  username!: string;

  @Column()
  password!: string;

  @Column({ type: 'float', default: 0 })
  balance!: number;

  @Column({ type: 'varchar', length: 64, unique: true, nullable: true })
  cardUid!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'", nullable: false })
  cardUids!: string[];

  @Column({ type: 'int', default: 0 })
  timeRemaining!: number;

  @Column({ type: 'int', default: 0 })
  lastPortConnected!: number;

  @Column({ type: 'int', default: 0 })
  activePort!: number;

  @Column({ type: 'varchar', length: 16, nullable: true })
  pendingAction!: PendingSessionAction | null;

  @Column({ type: 'int', default: 0 })
  pendingPort!: number;

  @Column({ type: 'int', default: 0 })
  pendingDurationMs!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  pendingMessage!: string | null;
}
