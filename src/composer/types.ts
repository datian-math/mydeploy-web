// ====== 新版组卷器 - 类型定义 ======

/** 每一道题的样式配置 */
export interface QuestionStyle {
  // 字体
  fontFamily: '默认' | '宋体' | '楷体' | '黑体';
  fontSize: number;           // 题目字号，默认 14
  fontColor: string;          // 如 '#333333'
  bold: boolean;

  // 段落
  textAlign: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;         // 默认 1.8

  // 背景与框线
  backgroundColor: string;    // 如 '#ffffff'
  hasBorder: boolean;
  borderColor: string;        // 如 '#f5a623'
  borderStyle: 'solid' | 'dashed' | 'none';
  borderRadius: number;       // 圆角，默认 8

  // 选项排列
  optionLayout: 'horizontal-4' | 'horizontal-2' | 'vertical';

  // 图片
  imageWidth: string;         // 如 '50%'、'150px'
  imageAlign: 'left' | 'center' | 'right';
}

/** 选题篮中的一道题（含样式） */
export interface ComposerQuestion {
  questionId: string;         // 原题库 id
  order: number;              // 排序序号
  style: QuestionStyle;
}

/** 全局试卷设置 */
export interface PaperSettings {
  title: string;
  subtitle: string;
  paperSize: 'a4' | 'b4';
  showPageNumber: boolean;
  showBorder: boolean;
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
}

/** 默认样式 */
export const DEFAULT_STYLE: QuestionStyle = {
  fontFamily: '默认',
  fontSize: 14,
  fontColor: '#333333',
  bold: false,
  textAlign: 'left',
  lineHeight: 1.8,
  backgroundColor: 'transparent',
  hasBorder: false,
  borderColor: '#f5a623',
  borderStyle: 'solid',
  borderRadius: 8,
  optionLayout: 'horizontal-4',
  imageWidth: '50%',
  imageAlign: 'center',
};

/** 经典颜色模板 */
export interface StyleTemplate {
  name: string;
  style: Partial<QuestionStyle>;
}

export const STYLE_TEMPLATES: StyleTemplate[] = [
  {
    name: '素雅白框',
    style: {
      backgroundColor: '#ffffff',
      hasBorder: true,
      borderColor: '#d0d0d0',
      borderStyle: 'solid',
      borderRadius: 6,
      fontColor: '#333333',
    },
  },
  {
    name: '淡蓝清新',
    style: {
      backgroundColor: '#f0f7ff',
      hasBorder: true,
      borderColor: '#4a90d9',
      borderStyle: 'solid',
      borderRadius: 6,
      fontColor: '#1a3a5c',
    },
  },
  {
    name: '浅黄重点',
    style: {
      backgroundColor: '#fffbea',
      hasBorder: true,
      borderColor: '#f5a623',
      borderStyle: 'solid',
      borderRadius: 6,
      fontColor: '#5c4b1e',
    },
  },
  {
    name: '淡绿标记',
    style: {
      backgroundColor: '#f0fff4',
      hasBorder: true,
      borderColor: '#48bb78',
      borderStyle: 'solid',
      borderRadius: 6,
      fontColor: '#1c4532',
    },
  },
  {
    name: '粉紫标注',
    style: {
      backgroundColor: '#faf5ff',
      hasBorder: true,
      borderColor: '#9f7aea',
      borderStyle: 'solid',
      borderRadius: 6,
      fontColor: '#44337a',
    },
  },
];

/** 默认试卷设置 */
export const DEFAULT_PAPER: PaperSettings = {
  title: '数学试卷',
  subtitle: '',
  paperSize: 'b4',
  showPageNumber: true,
  showBorder: false,
  headerLeft: '[title]',
  headerCenter: '',
  headerRight: '第 [page] 页',
};
