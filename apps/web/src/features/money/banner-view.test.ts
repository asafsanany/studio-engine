import { describe, expect, it } from 'vitest';
import {
  BANNER_KINDS,
  BANNER_TONE_STYLES,
  bannerDelta,
  bannerDirection,
  bannerPercent,
  bannerTone,
  bannerViews,
  incomeDescription,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  sparklinePoints,
  unpaidLine,
} from './banner-view';

describe('bannerTone', () => {
  it('is good when income or profit went up, bad when it went down', () => {
    expect(bannerTone('income', 5200, 4400)).toBe('good');
    expect(bannerTone('income', 3800, 4400)).toBe('bad');
    expect(bannerTone('profit', 4240, 3462)).toBe('good');
    expect(bannerTone('profit', 3000, 3462)).toBe('bad');
  });

  it('is the other way round for expenses: less is good, more is bad', () => {
    expect(bannerTone('expenses', 900, 940)).toBe('good');
    expect(bannerTone('expenses', 960, 940)).toBe('bad');
  });

  it('is flat when nothing changed, for every kind', () => {
    for (const kind of BANNER_KINDS) {
      expect(bannerTone(kind, 4400, 4400)).toBe('flat');
      expect(bannerTone(kind, 0, 0)).toBe('flat');
    }
  });

  it('judges the shekels the card prints: a change below half a shekel is flat', () => {
    expect(bannerTone('income', 4400.3, 4400)).toBe('flat');
    expect(bannerTone('expenses', 960.4, 960.1)).toBe('flat');
    // 4239.6 is printed ₪4,240 and 4239.4 ₪4,239: a shekel apart, so it is a change.
    expect(bannerTone('profit', 4239.6, 4239.4)).toBe('good');
  });

  it('works for negative profit: going from -500 to -100 is up, so good', () => {
    expect(bannerTone('profit', -100, -500)).toBe('good');
    expect(bannerTone('profit', -500, -100)).toBe('bad');
    expect(bannerTone('profit', 300, -500)).toBe('good');
  });
});

describe('bannerDirection', () => {
  it('says which way the amount went, to the shekel', () => {
    expect(bannerDirection(5200, 4400)).toBe('up');
    expect(bannerDirection(3800, 4400)).toBe('down');
    expect(bannerDirection(4400, 4400)).toBe('flat');
    expect(bannerDirection(4400.2, 4400)).toBe('flat');
  });
});

describe('bannerPercent', () => {
  it('is the change as a rounded percentage of last month, with its sign', () => {
    expect(bannerPercent(5200, 4400)).toBe('+18%');
    expect(bannerPercent(3800, 4400)).toBe('−14%');
    expect(bannerPercent(960.4, 937.9)).toBe('+2%');
  });

  it('is 0% with no sign when nothing changed', () => {
    expect(bannerPercent(4400, 4400)).toBe('0%');
    expect(bannerPercent(0, 0)).toBe('0%');
  });

  it('is relative to the size of last month, so the sign follows the change when profit is negative', () => {
    expect(bannerPercent(-100, -500)).toBe('+80%');
    expect(bannerPercent(-500, -100)).toBe('−400%');
    expect(bannerPercent(300, -500)).toBe('+160%');
  });

  it('says "New" when last month was zero and this month is not', () => {
    expect(bannerPercent(960, 0)).toBe('New');
    expect(bannerPercent(-960, 0)).toBe('New');
  });
});

describe('bannerDelta', () => {
  it('says the difference, the month compared with, and what that month was', () => {
    expect(bannerDelta('2026-10', 5200, 4400)).toBe('+₪800 vs September (₪4,400)');
    expect(bannerDelta('2026-10', 3800, 4400)).toBe('−₪600 vs September (₪4,400)');
  });

  it('is the difference of the two printed amounts', () => {
    // 960.4 and 937.9 print as ₪960 and ₪938.
    expect(bannerDelta('2026-10', 960.4, 937.9)).toBe('+₪22 vs September (₪938)');
  });

  it('says "Same as September" when it did not change', () => {
    expect(bannerDelta('2026-10', 4400, 4400)).toBe('Same as September');
    expect(bannerDelta('2026-10', 4400.2, 4400)).toBe('Same as September');
  });

  it('names the month before across a year, and writes a negative previous amount with the minus', () => {
    expect(bannerDelta('2026-01', 100, 50)).toBe('+₪50 vs December (₪50)');
    expect(bannerDelta('2026-10', 100, -500)).toBe('+₪600 vs September (−₪500)');
  });
});

describe('incomeDescription', () => {
  it('says the number of jobs and their price', () => {
    const jobs = Array.from({ length: 26 }, () => ({ income: 200 }));
    expect(incomeDescription(jobs)).toBe('26 jobs at ₪200');
    expect(incomeDescription([{ income: 250 }])).toBe('1 job at ₪250');
  });

  it('shows agorot when the price has them', () => {
    expect(incomeDescription([{ income: 247.5 }, { income: 247.5 }])).toBe('2 jobs at ₪247.50');
  });

  it('calls the jobs what it is told to (the phone says videos), and says so for none', () => {
    const videos = { one: 'video', many: 'videos' };
    expect(incomeDescription([{ income: 40 }, { income: 40 }], videos)).toBe('2 videos at ₪40');
    expect(incomeDescription([{ income: 40 }], videos)).toBe('1 video at ₪40');
    expect(incomeDescription([], videos)).toBe('No videos delivered');
    expect(incomeDescription([])).toBe('No jobs delivered');
  });

  it('says only the count when the jobs were not all priced alike', () => {
    expect(incomeDescription([{ income: 200 }, { income: 250 }, { income: 200 }])).toBe('3 jobs');
  });

  it('says so when no job was delivered', () => {
    expect(incomeDescription([])).toBe('No jobs delivered');
  });
});

describe('sparklinePoints', () => {
  const rise = [0, 10, 20, 30, 40, 50, 60, 70];

  it('spans the box from 2 px in to 2 px short of the right edge', () => {
    const { line } = sparklinePoints(rise);
    const points = line.split(' ').map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(8);
    expect(points[0]?.[0]).toBe(2);
    expect(points[7]?.[0]).toBe(SPARKLINE_WIDTH - 2);
  });

  it('puts the lowest value 4 px above the bottom and the highest 4 px below the top', () => {
    const { line } = sparklinePoints(rise);
    const ys = line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(ys[0]).toBe(SPARKLINE_HEIGHT - 4);
    expect(ys[7]).toBe(4);
  });

  it('writes points to one decimal, like the board', () => {
    expect(sparklinePoints(rise).line.split(' ')[1]).toBe('22.9,38.3');
  });

  it('closes the area along the bottom edge', () => {
    const { line, area } = sparklinePoints(rise);
    expect(area).toBe(`2,48 ${line} 148.0,48`);
  });

  it('draws values that are all the same as a line along the bottom', () => {
    const { line } = sparklinePoints([5, 5, 5, 5, 5, 5, 5, 5]);
    for (const point of line.split(' ')) expect(point.split(',')[1]).toBe('44.0');
    expect(sparklinePoints([0, 0, 0, 0, 0, 0, 0, 0]).line).toBe(line);
  });

  it('copes with one value or none', () => {
    expect(sparklinePoints([3]).line).toBe('75.0,44.0');
    expect(sparklinePoints([])).toEqual({ line: '', area: '' });
  });
});

describe('BANNER_TONE_STYLES', () => {
  it('has the board colours: green, red and grey', () => {
    expect(BANNER_TONE_STYLES.good).toEqual({
      card: 'border-[rgba(74,222,128,0.35)] bg-[rgba(34,197,94,0.07)]',
      pill: 'bg-[rgba(74,222,128,0.14)]',
      accent: 'text-[#4ADE80]',
    });
    expect(BANNER_TONE_STYLES.bad).toEqual({
      card: 'border-[rgba(248,113,113,0.38)] bg-[rgba(239,68,68,0.07)]',
      pill: 'bg-[rgba(248,113,113,0.14)]',
      accent: 'text-[#F87171]',
    });
    expect(BANNER_TONE_STYLES.flat).toEqual({
      card: 'border-[rgba(255,255,255,0.1)] bg-transparent',
      pill: 'bg-[rgba(255,255,255,0.06)]',
      accent: 'text-[#A1A1AA]',
    });
  });
});

describe('bannerViews', () => {
  const history = [3200, 3600, 3400, 3800, 4000, 3800, 4400, 5200];
  const banners = {
    income: { value: 5200, previous: 4400, history, unpaid: { value: 120, count: 3 } },
    expenses: {
      value: 960.4,
      previous: 937.9,
      history: [900, 910, 905, 930, 940, 935, 937.9, 960.4],
    },
    profit: {
      value: 4239.6,
      previous: 3462.1,
      history: [2300, 2690, 2495, 2870, 3060, 2865, 3462.1, 4239.6],
    },
  };
  const ledger = Array.from({ length: 26 }, () => ({ income: 200 }));
  const views = bannerViews('2026-10', banners, ledger);

  it('are Income, Expenses and Profit, in that order', () => {
    expect(views.map((v) => v.title)).toEqual(['Income', 'Expenses', 'Profit']);
    expect(views.map((v) => v.kind)).toEqual(['income', 'expenses', 'profit']);
  });

  it('describe each as the board does', () => {
    expect(views.map((v) => v.description)).toEqual([
      '26 jobs at ₪200',
      'Subscriptions and API charges',
      'Income minus expenses',
    ]);
  });

  it('give the amount in whole shekels, the pill, the tone and the change in words', () => {
    expect(views.map((v) => v.value)).toEqual(['₪5,200', '₪960', '₪4,240']);
    expect(views.map((v) => v.percent)).toEqual(['+18%', '+2%', '+22%']);
    expect(views.map((v) => v.direction)).toEqual(['up', 'up', 'up']);
    // More expenses are bad even though the amount went up.
    expect(views.map((v) => v.tone)).toEqual(['good', 'bad', 'good']);
    expect(views[0]?.delta).toBe('+₪800 vs September (₪4,400)');
  });

  it('draw the eight months of history', () => {
    expect(views[0]?.sparkline).toEqual(sparklinePoints(history));
  });

  it('give the Income card its "not paid yet" line, and no other card', () => {
    expect(views.map((v) => v.unpaid)).toEqual([
      { amount: '₪120', text: 'not paid yet · 3 videos' },
      null,
      null,
    ]);
  });

  it('leave the line out when everything delivered is paid', () => {
    const paid = bannerViews(
      '2026-10',
      { ...banners, income: { ...banners.income, unpaid: { value: 0, count: 0 } } },
      ledger,
    );
    expect(paid[0]?.unpaid).toBeNull();
  });
});

describe('unpaidLine', () => {
  it('says the amount in whole shekels and how many videos it is', () => {
    expect(unpaidLine({ value: 120, count: 3 })).toEqual({
      amount: '₪120',
      text: 'not paid yet · 3 videos',
    });
    expect(unpaidLine({ value: 1240.5, count: 31 })).toEqual({
      amount: '₪1,241',
      text: 'not paid yet · 31 videos',
    });
  });

  it('says "1 video" for one', () => {
    expect(unpaidLine({ value: 40, count: 1 })).toEqual({
      amount: '₪40',
      text: 'not paid yet · 1 video',
    });
  });

  it('is nothing when no video is owed', () => {
    expect(unpaidLine({ value: 0, count: 0 })).toBeNull();
  });
});
