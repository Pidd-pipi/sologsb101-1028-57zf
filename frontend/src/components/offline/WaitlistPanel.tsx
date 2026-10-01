/**
 * 候补场次面板：容量不足的场次按提交顺序排队在此。
 * 不挤掉已确认场次；棚号 / 乐手变化后可重新核算，容量足够且时段空闲时转正。
 */
import { useMemo } from 'react';
import { Button, Card, Space, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useIdbTable } from '@/hooks/useIdbTable';
import { db, recalcSessionCapacity, type ProjectRow, type SessionRow, type SongRow } from '@/utils/db';
import { evaluateCapacity } from '@/utils/capacity';

export default function WaitlistPanel() {
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);

  const waitlist = useMemo(
    () =>
      sessions
        .filter((item) => item.state === '候补')
        .sort((a, b) => (a.submittedAt ?? a.createdAt) - (b.submittedAt ?? b.createdAt)),
    [sessions]
  );

  const songLabel = (session: SessionRow): string => {
    const song = songs.find((item) => item.id === session.songId);
    if (!song) return '曲目已删除';
    const project = projects.find((item) => item.id === song.projectId);
    return `${song.title}${project ? ` · ${project.name}` : ''}`;
  };

  async function handleRecalc(session: SessionRow): Promise<void> {
    try {
      const { capacity, promoted } = await recalcSessionCapacity(session.id);
      if (promoted) {
        message.success(`${songLabel(session)} 容量已足够，已转正排期`);
      } else if (capacity.over) {
        message.warning(`仍超容：${capacity.reason}`);
      } else {
        message.info('容量已足够，但棚号时段仍被占用，继续候补');
      }
    } catch (error) {
      message.error(`核算失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  if (waitlist.length === 0) return null;

  return (
    <Card
      title={
        <Space>
          <span>候补场次</span>
          <Tag color="red">{waitlist.length}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            容量不足按提交顺序排队，不挤掉已确认场次
          </Typography.Text>
        </Space>
      }
    >
      <Table<SessionRow>
        rowKey="id"
        dataSource={waitlist}
        pagination={false}
        size="small"
        columns={[
          {
            title: '顺位',
            width: 70,
            render: (_, __, index) => <Tag color="default">{index + 1}</Tag>
          },
          {
            title: '场次',
            minWidth: 200,
            render: (_, row) => (
              <Space direction="vertical" size={2}>
                <span>{songLabel(row)}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.date} {row.period} · {row.roomNo} · {row.source === '离线包' ? `离线包 ${row.packageNo ?? ''}` : '本地'}
                </Typography.Text>
              </Space>
            )
          },
          {
            title: '容量核算',
            minWidth: 220,
            render: (_, row) => {
              const capacity = evaluateCapacity(row.musicians, row.roomNo);
              return (
                <Space direction="vertical" size={2}>
                  <Tag color={capacity.over ? 'red' : 'green'}>
                    乐手 {capacity.count} / 容量 {capacity.capacity}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {capacity.reason}
                  </Typography.Text>
                </Space>
              );
            }
          },
          {
            title: '操作',
            width: 120,
            render: (_, row) => (
              <Button size="small" icon={<ReloadOutlined />} onClick={() => handleRecalc(row)}>
                重新核算
              </Button>
            )
          }
        ]}
      />
    </Card>
  );
}
