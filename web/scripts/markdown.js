/* 轻量 Markdown 渲染器：代码块、引用块、列表、任务清单、标题、链接、粗斜体、水平线与行内代码。
   与桌面版 scripts/markdown.js 的解析顺序一致，正文与 AI 回答都经这里转成 HTML。 */

/* ---------------- 链接地址安全 ----------------
   渲染结果会被写进 innerHTML，因此链接协议先过一遍白名单：
   只放行 http(s) / mailto / tel 与不带协议的站内相对地址，
   javascript: / data: / vbscript: 等可执行协议一律降级为纯文本。 */

const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
// 形如 javascript: 的协议前缀
const LINK_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/;
// 协议判断前要去掉的不可见字符（java&#x09;script: 这类伪装）
const LINK_INVISIBLE_PATTERN = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;
// 实体解码：命名实体与十进制 / 十六进制实体，只解一层
const LINK_ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;
const LINK_NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0'
};

function decodeLinkEntities(value) {
    return String(value).replace(LINK_ENTITY_PATTERN, (match, dec, hex, name) => {
        if (dec) {
            const code = Number(dec);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        if (hex) {
            const code = parseInt(hex, 16);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(LINK_NAMED_ENTITIES, key) ? LINK_NAMED_ENTITIES[key] : match;
    });
}

function escapeLinkAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 返回可安全写入 href 的地址；协议不被放行时返回空字符串（调用方降级为纯文本）
function sanitizeLinkUrl(raw) {
    const decoded = decodeLinkEntities(raw).trim();
    if (!decoded) return '';
    const compact = decoded.replace(LINK_INVISIBLE_PATTERN, '').toLowerCase();
    const scheme = compact.match(LINK_SCHEME_PATTERN);
    if (scheme && !SAFE_LINK_SCHEMES.includes(scheme[0])) return '';
    return escapeLinkAttribute(decoded);
}

const Markdown = {
    /* 正文 → HTML。占位符用于把代码块与行内代码先摘出去，
       避免它们的内容被后续的加粗 / 链接等规则改写。 */
    parse(value = '') {
        if (!value) return '';

        // 占位符不能含 * _ ` [ ] 等 Markdown 语义字符，否则会被后续正则改写而无法还原
        const codeBlockToken = (i) => `@@ESPRINCODEBLOCK${i}@@`;
        const inlineCodeToken = (i) => `@@ESPRININLINECODE${i}@@`;

        const codeBlocks = [];
        let text = String(value).replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
            const id = codeBlockToken(codeBlocks.length);
            const escaped = escapeHTML(code);
            codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${escaped}</code></pre>`);
            return id;
        });

        const inlineCodes = [];
        text = text.replace(/`([^`\n]+)`/g, (match, code) => {
            const id = inlineCodeToken(inlineCodes.length);
            inlineCodes.push(`<code>${escapeHTML(code)}</code>`);
            return id;
        });

        text = escapeHTML(text);

        // 标题
        text = text
            .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
            .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
            .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
            .replace(/^### (.*)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*)$/gm, '<h2>$1</h2>')
            .replace(/^# (.*)$/gm, '<h1>$1</h1>');

        // 分割线
        text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr>');

        // 表格：表头行 + 分隔行（用 : 决定该列对齐）+ 若干表体行。
        // 以「分隔行」为成立条件，正文里零星出现的竖线因此不会被误判成表格；
        // 行首行尾的竖线可有可无，两种写法都兼容
        text = text.replace(
            /(^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*\r?\n)(^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*\r?\n)((?:^[ \t]*\|?[^\r\n|]*(?:\|[^\r\n|]*)+[ \t]*\|?[ \t]*(?:\r?\n|$))*)/gm,
            (block, headerRow, dividerRow, bodyRows) => {
                // 去掉首尾竖线后按 | 切列
                const splitCells = (row) => row
                    .trim()
                    .replace(/^\||\|$/g, '')
                    .split('|')
                    .map(cell => cell.trim());
                const aligns = splitCells(dividerRow).map(spec => {
                    const left = spec.startsWith(':');
                    const right = spec.endsWith(':');
                    if (left && right) return 'center';
                    if (right) return 'right';
                    if (left) return 'left';
                    return '';
                });
                const alignStyle = (index) => (aligns[index] ? ` style="text-align: ${aligns[index]}"` : '');
                const head = splitCells(headerRow)
                    .map((cell, i) => `<th${alignStyle(i)}>${cell}</th>`)
                    .join('');
                const body = bodyRows
                    .split(/\r?\n/)
                    .filter(row => row.trim())
                    .map(row => `<tr>${splitCells(row).map((cell, i) => `<td${alignStyle(i)}>${cell}</td>`).join('')}</tr>`)
                    .join('');
                // 外层容器负责窄屏横向滚动；前后补空行，避免表格被并进相邻段落
                return `\n\n<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>\n\n`;
            }
        );

        // 引用块（支持多行连续引用）
        text = text.replace(/(?:^&gt; ?[^\r\n]*(?:\r?\n|$))+/gm, (block) => {
            const inner = block
                .split(/\r?\n/)
                .filter(line => line.length > 0)
                .map(line => line.replace(/^&gt; ?/, ''))
                .join('<br>');
            return `<blockquote><p>${inner}</p></blockquote>\n`;
        });

        // 任务清单与普通列表项
        text = text.replace(/^- \[ \] (.*)$/gm, '<li class="task-item"><input type="checkbox" disabled> $1</li>');
        text = text.replace(/^- \[x\] (.*)$/gm, '<li class="task-item"><input type="checkbox" checked disabled> $1</li>');
        text = text.replace(/^[-*+] (.*)$/gm, '<li>$1</li>');
        text = text.replace(/^\d+\. (.*)$/gm, '<li class="ordered">$1</li>');

        // 连续的 <li> 各自包进 <ol> / <ul>
        text = text.replace(/(?:<li class="ordered">.*?<\/li>\s*)+/g, '<ol>$&</ol>');
        text = text.replace(/(?:<li>.*?<\/li>\s*|<li class="task-item">.*?<\/li>\s*)+/g, '<ul>$&</ul>');

        // 粗体、斜体、删除线与链接
        text = text
            .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/\*([^\*\n]+?)\*/g, '<em>$1</em>')
            // 下划线斜体不允许出现在单词内部，避免 snake_case_name 被吃掉下划线
            .replace(/(^|[^\w])_([^_\n]+?)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
            .replace(/~~(.+?)~~/g, '<del>$1</del>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
                const safeUrl = sanitizeLinkUrl(url);
                return safeUrl
                    ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
                    : label;
            });

        // 段落与换行：代码块占位符独占段落，还原后不会与其它文本挤进同一个 <p>
        text = text.replace(/[ \t]*@@ESPRINCODEBLOCK(\d+)@@[ \t]*/g, (match, idx) => `\n\n@@ESPRINCODEBLOCK${idx}@@\n\n`);
        text = text.split(/(?:\r?\n){2,}/).map(paragraph => {
            const block = paragraph.trim();
            if (!block) return '';
            if (/^(?:@@ESPRINCODEBLOCK\d+@@\s*)+$/.test(block)) return block;
            if (/^<(?:h[1-6]|ul|ol|blockquote|hr|pre|div|table)/i.test(block)) return block;
            return `<p>${block.replace(/\r?\n/g, '<br>')}</p>`;
        }).filter(Boolean).join('\n');

        // 还原行内代码与代码块：用函数式替换，避免内容里的 $& $1 被当作替换模式
        inlineCodes.forEach((code, idx) => {
            text = text.replace(inlineCodeToken(idx), () => code);
        });
        codeBlocks.forEach((block, idx) => {
            text = text.replace(codeBlockToken(idx), () => block);
        });

        return text;
    }
};
