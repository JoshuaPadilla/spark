import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('payment_webhook_events')
@Unique(['eventId'])
export class PaymentWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  eventId!: string;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'float' })
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
