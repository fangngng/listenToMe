/* 经典朗读样例：全部为公版作品（中国作者逝世逾 50 年 / 英文 1928 年前出版），可自由用于朗读练习 */

export const SAMPLES = [
  // ---------- 中文 ----------
  {
    lang: 'zh', title: '静夜思', author: '李白',
    text: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
  },
  {
    lang: 'zh', title: '春晓', author: '孟浩然',
    text: '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
  },
  {
    lang: 'zh', title: '登鹳雀楼', author: '王之涣',
    text: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
  },
  {
    lang: 'zh', title: '水调歌头·明月几时有', author: '苏轼',
    text: '明月几时有？把酒问青天。不知天上宫阙，今夕是何年。我欲乘风归去，又恐琼楼玉宇，高处不胜寒。起舞弄清影，何似在人间。转朱阁，低绮户，照无眠。不应有恨，何事长向别时圆？人有悲欢离合，月有阴晴圆缺，此事古难全。但愿人长久，千里共婵娟。',
  },
  {
    lang: 'zh', title: '陋室铭', author: '刘禹锡',
    text: '山不在高，有仙则名。水不在深，有龙则灵。斯是陋室，惟吾德馨。苔痕上阶绿，草色入帘青。谈笑有鸿儒，往来无白丁。可以调素琴，阅金经。无丝竹之乱耳，无案牍之劳形。南阳诸葛庐，西蜀子云亭。孔子云：何陋之有？',
  },
  {
    lang: 'zh', title: '爱莲说', author: '周敦颐',
    text: '水陆草木之花，可爱者甚蕃。晋陶渊明独爱菊。自李唐来，世人甚爱牡丹。予独爱莲之出淤泥而不染，濯清涟而不妖，中通外直，不蔓不枝，香远益清，亭亭净植，可远观而不可亵玩焉。予谓菊，花之隐逸者也；牡丹，花之富贵者也；莲，花之君子者也。噫！菊之爱，陶后鲜有闻。莲之爱，同予者何人？牡丹之爱，宜乎众矣！',
  },
  {
    lang: 'zh', title: '匆匆（节选）', author: '朱自清',
    text: '燕子去了，有再来的时候；杨柳枯了，有再青的时候；桃花谢了，有再开的时候。但是，聪明的，你告诉我，我们的日子为什么一去不复返呢？——是有人偷了他们罢：那是谁？又藏在何处呢？是他们自己逃走了罢：现在又到了哪里呢？',
  },
  {
    lang: 'zh', title: '再别康桥', author: '徐志摩',
    text: '轻轻的我走了，正如我轻轻的来；我轻轻的招手，作别西天的云彩。那河畔的金柳，是夕阳中的新娘；波光里的艳影，在我的心头荡漾。软泥上的青荇，油油的在水底招摇；在康河的柔波里，我甘心做一条水草！那榆荫下的一潭，不是清泉，是天上虹；揉碎在浮藻间，沉淀着彩虹似的梦。寻梦？撑一支长篙，向青草更青处漫溯；满载一船星辉，在星辉斑斓里放歌。但我不能放歌，悄悄是别离的笙箫；夏虫也为我沉默，沉默是今晚的康桥！悄悄的我走了，正如我悄悄的来；我挥一挥衣袖，不带走一片云彩。',
  },
  {
    lang: 'zh', title: '从百草园到三味书屋（节选）', author: '鲁迅',
    text: '不必说碧绿的菜畦，光滑的石井栏，高大的皂荚树，紫红的桑椹；也不必说鸣蝉在树叶里长吟，肥胖的黄蜂伏在菜花上，轻捷的叫天子忽然从草间直窜向云霄里去了。单是周围的短短的泥墙根一带，就有无限趣味。',
  },
  // ---------- 英文 ----------
  {
    lang: 'en', title: "Sonnet 18", author: 'William Shakespeare',
    text: "Shall I compare thee to a summer's day? Thou art more lovely and more temperate: Rough winds do shake the darling buds of May, And summer's lease hath all too short a date: Sometime too hot the eye of heaven shines, And often is his gold complexion dimm'd; And every fair from fair sometime declines, By chance or nature's changing course untrimm'd; But thy eternal summer shall not fade, Nor lose possession of that fair thou owest; Nor shall Death brag thou wander'st in his shade, When in eternal lines to time thou growest: So long as men can breathe or eyes can see, So long lives this, and this gives life to thee.",
  },
  {
    lang: 'en', title: 'Ozymandias', author: 'Percy Bysshe Shelley',
    text: "I met a traveller from an antique land, Who said—\"Two vast and trunkless legs of stone Stand in the desert. . . . Near them, on the sand, Half sunk a shattered visage lies, whose frown, And wrinkled lip, and sneer of cold command, Tell that its sculptor well those passions read Which yet survive, stamped on these lifeless things, The hand that mocked them, and the heart that fed; And on the pedestal, these words appear: My name is Ozymandias, King of Kings; Look on my Works, ye Mighty, and despair! Nothing beside remains. Round the decay Of that colossal Wreck, boundless and bare The lone and level sands stretch far away.\"",
  },
  {
    lang: 'en', title: 'Invictus', author: 'William Ernest Henley',
    text: 'Out of the night that covers me, Black as the pit from pole to pole, I thank whatever gods may be For my unconquerable soul. In the fell clutch of circumstance I have not winced nor cried aloud. Under the bludgeonings of chance My head is bloody, but unbowed. Beyond this place of wrath and tears Looms but the Horror of the shade, And yet the menace of the years Finds and shall find me unafraid. It matters not how strait the gate, How charged with punishments the scroll, I am the master of my fate, I am the captain of my soul.',
  },
  {
    lang: 'en', title: 'If— (excerpt)', author: 'Rudyard Kipling',
    text: "If you can keep your head when all about you Are losing theirs and blaming it on you, If you can trust yourself when all men doubt you, But make allowance for their doubting too; If you can wait and not be tired by waiting, Or being lied about, don't deal in lies, Or being hated, don't give way to hating, And yet don't look too good, nor talk too wise: If you can dream—and not make dreams your master; If you can think—and not make thoughts your aim; If you can meet with Triumph and Disaster And treat those two impostors just the same.",
  },
  {
    lang: 'en', title: 'The Road Not Taken', author: 'Robert Frost',
    text: 'Two roads diverged in a yellow wood, And sorry I could not travel both And be one traveler, long I stood And looked down one as far as I could To where it bent in the undergrowth; Then took the other, as just as fair, And having perhaps the better claim, Because it was grassy and wanted wear; Though as for that the passing there Had worn them really about the same, And both that morning equally lay In leaves no step had trodden black. Oh, I kept the first for another day! Yet knowing how way leads on to way, I doubted if I should ever come back. I shall be telling this with a sigh Somewhere ages and ages hence: Two roads diverged in a wood, and I— I took the one less traveled by, And that has made all the difference.',
  },
  {
    lang: 'en', title: 'I Wandered Lonely as a Cloud (excerpt)', author: 'William Wordsworth',
    text: "I wandered lonely as a cloud That floats on high o'er vales and hills, When all at once I saw a crowd, A host, of golden daffodils; Beside the lake, beneath the trees, Fluttering and dancing in the breeze. Continuous as the stars that shine And twinkle on the milky way, They stretched in never-ending line Along the margin of a bay: Ten thousand saw I at a glance, Tossing their heads in sprightly dance.",
  },
  {
    lang: 'en', title: 'A Red, Red Rose', author: 'Robert Burns',
    text: "O my Luve is like a red, red rose That's newly sprung in June; O my Luve is like the melody That's sweetly played in tune. So fair art thou, my bonnie lass, So deep in luve am I: And I will luve thee still, my dear, Till a' the seas gang dry: Till a' the seas gang dry, my dear, And the rocks melt wi' the sun: I will love thee still, my dear, While the sands o' life shall run.",
  },
  {
    lang: 'en', title: 'Gettysburg Address', author: 'Abraham Lincoln',
    text: 'Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal. Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battle-field of that war. We have come to dedicate a portion of that field, as a final resting place for those who here gave their lives that that nation might live. It is altogether fitting and proper that we should do this. But, in a larger sense, we can not dedicate — we can not consecrate — we can not hallow — this ground. The brave men, living and dead, who struggled here, have consecrated it, far above our poor power to add or detract. The world will little note, nor long remember what we say here, but it can never forget what they did here. It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced. It is rather for us to be here dedicated to the great task remaining before us — that from these honored dead we take increased devotion to that cause for which they gave the last full measure of devotion — that we here highly resolve that these dead shall not have died in vain — that this nation, under God, shall have a new birth of freedom — and that government of the people, by the people, for the people, shall not perish from the earth.',
  },
]
