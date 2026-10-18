// 직접 만든 65% 데모. 제작사의 정의 파일을 포함하지 않는다.
export function demoDefinition() {
  const keys = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 15; col++) {
    if (row === 4 && col > 2 && col < 9) continue;
    if (row === 0 && col === 14) continue;
    keys.push({ row, col, x: col, y: row, w: row === 4 && col === 2 ? 7 : 1, h: 1, color: col === 0 ? 'accent' : row === 4 ? 'mod' : 'alpha' });
  }
  return {
    name: 'GOMM VIA 65', vendorId: 0xfeed, productId: 0x0065, matrix: { rows: 5, cols: 16 },
    layouts: { keys, labels: [['Backspace', 'Full', 'Split']], optionKeys: { 0: {
      0: [{ row: 0, col: 14, x: 14, y: 0, w: 1, h: 1, color: 'mod' }],
      1: [{ row: 0, col: 14, x: 14, y: 0, w: 0.5, h: 1 }, { row: 0, col: 15, x: 14.5, y: 0, w: 0.5, h: 1 }],
    } } },
    customKeycodes: [{ name: 'Desk mode', shortName: 'Desk' }, { name: 'Focus mode', shortName: 'Focus' }],
    menus: [{ label: 'Lighting', content: [{ label: 'Backlight', content: [
      { label: 'Enabled', type: 'toggle', content: ['enabled', 1, 1] },
      { label: 'Brightness', type: 'range', options: [0, 255], content: ['brightness', 1, 2], showIf: '{enabled} != 0' },
      { label: 'Effect', type: 'dropdown', options: [['Static', 0], ['Breathing', 1]], content: ['effect', 1, 3] },
      { label: 'Color', type: 'color', content: ['color', 1, 4] },
    ] }] }],
  };
}
