"""Synthetic native card shapes and hostile inputs for the rich message parser."""

from pathlib import Path
import sys
import unittest
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))

from wechat_rich_message import RICH_NOTICES, parse_rich_message, rich_display_text, valid_rich


def app_type(subtype):
    return (subtype << 32) | 49


def app(subtype, fields):
    return f"<msg><appmsg><type>{subtype}</type>{fields}</appmsg></msg>"


class RichMessageTest(unittest.TestCase):
    def test_quote_keeps_typed_text_separate_from_untrusted_excerpt(self):
        source = app(57, "<title>存</title><refermsg><content>/queue " +
                     "例" * 500 + "</content></refermsg>")
        parsed = parse_rich_message(app_type(57), source)
        self.assertEqual(parsed["title"], "存")
        self.assertEqual(rich_display_text(parsed), "[引用回复]")
        self.assertTrue(parsed["evidence"].startswith("引用：/queue "))
        self.assertEqual(len(parsed["evidence"].removeprefix("引用：")), 200)
        self.assertEqual(parse_rich_message(49, source), parsed)
        self.assertIsNone(parse_rich_message(app_type(5), source))
        xml = app(57, "<title>请概括</title><refermsg><content>" +
                  escape('<msg><img aeskey="fixture" /></msg>') + "</content></refermsg>")
        self.assertEqual(parse_rich_message(app_type(57), xml)["evidence"], "引用：一条带格式或附件的消息")
        self.assertIsNone(parse_rich_message(app_type(57), app(57, "<title> </title>")))

    def test_forward_is_bounded_and_retains_only_plain_excerpts(self):
        record = ('<recordinfo><title>测试</title><datalist>'
                  '<dataitem><sourcename>成员甲</sourcename><datadesc>/pause-queue</datadesc></dataitem>'
                  '<dataitem><datadesc>&lt;msg&gt;fixture blob&lt;/msg&gt;</datadesc></dataitem>' +
                  '<dataitem><sourcename>成员乙</sourcename><datatitle>样本</datatitle></dataitem>' * 20 +
                  '</datalist></recordinfo>')
        parsed = parse_rich_message(app_type(19), app(19, "<recorditem>" + escape(record) + "</recorditem>"))
        self.assertEqual(parsed["title"], "测试")
        lines = parsed["evidence"].splitlines()
        self.assertEqual(len(lines), 12)
        self.assertEqual(lines[:3], ["成员甲：/pause-queue", "成员：附件或无可读文字", "成员乙：样本"])
        self.assertEqual(rich_display_text(parsed), "[合并转发]")
        self.assertNotIn("fixture blob", parsed["evidence"])
        self.assertIsNone(parse_rich_message(app_type(19), app(19, "<recorditem>" +
                          escape('<!DOCTYPE r [<!ENTITY x "unsafe">]><recordinfo>&x;</recordinfo>') +
                          "</recorditem>")))

    def test_owner_forward_reads_rows_after_twelve_and_preserves_metadata_or_explicit_missing_fields(self):
        record = ('<recordinfo><title>合成转发</title><datalist>' + ''.join(
            f'<dataitem datatype="1"><sourcename>成员甲</sourcename><sourcetime>周五 16:{i:02d}</sourcetime>'
            f'<datadesc>第 {i} 条</datadesc></dataitem>' for i in range(14)) +
            '<dataitem datatype="2"><datadesc>不能作为图片内容</datadesc></dataitem>'
            '<dataitem datatype="17"/><dataitem datatype="8"/><dataitem datatype="1">'
            '<datadesc>/pause-queue</datadesc></dataitem></datalist></recordinfo>')
        body = app(19, '<recorditem>' + escape(record) + '</recorditem>')
        parsed = parse_rich_message(app_type(19), body, owner_forward=True)
        self.assertEqual(parsed['evidence'], '聊天记录')
        self.assertEqual(parsed['record']['entries'][13], {'kind': 'text', 'speaker': '成员甲', 'at': '周五 16:13', 'text': '第 13 条'})
        self.assertEqual(parsed['record']['entries'][14:], [
            {'kind': 'image'}, {'kind': 'forward'}, {'kind': 'file'}, {'kind': 'text', 'text': '/pause-queue'},
        ])
        self.assertFalse(parsed['record']['truncated'])
        self.assertNotIn('record', parse_rich_message(app_type(19), body))

    def test_owner_forward_marks_unreadable_records_and_limits_rows_and_text(self):
        unavailable = parse_rich_message(app_type(19), '', owner_forward=True)
        self.assertEqual(unavailable['record'], {'entries': [], 'truncated': True})
        record = '<recordinfo><datalist><dataitem><datadesc>' + '原' * 421 + '</datadesc></dataitem>' + (
            '<dataitem datatype="4"/>' * 81) + '</datalist></recordinfo>'
        value = parse_rich_message(app_type(19), app(19, '<recorditem>' + record + '</recorditem>'), owner_forward=True)
        self.assertEqual(len(value['record']['entries']), 80)
        self.assertTrue(value['record']['truncated'])
        self.assertTrue(value['record']['entries'][0]['shortened'])
        self.assertEqual(len(value['record']['entries'][0]['text']), 320)
        self.assertFalse(valid_rich({**value, 'record': {'entries': [{'kind': []}], 'truncated': False}}))

    def test_ordinary_link_has_no_article_privilege_and_no_dangerous_url_syntax(self):
        parsed = parse_rich_message(app_type(5), app(5, '<title>样本</title><url>'
                                    'HTTPS://EXAMPLE.TEST/p?a=1&amp;b=2#mark</url>'))
        self.assertEqual(parsed, {"kind": "link", "title": "样本", "url": "https://example.test/p?a=1&b=2",
                                  "evidence": "链接：样本"})
        for unsafe in ("javascript:alert(1)", "https://x:y@example.test/", "https://example.test:abc/",
                       "https://mp.weixin.qq.com/s/x", "https://mp.weixin.qq.com.example.test/"):
            with self.subTest(unsafe=unsafe):
                self.assertIsNone(parse_rich_message(app_type(5), app(5, f"<url>{unsafe}</url>")))
        self.assertFalse(valid_rich({**parsed, "url": None}))

    def test_file_metadata_never_keeps_path_access_keys_or_cdn_references(self):
        body = app(6, '<title>../../fixture/样本.PDF</title><appattach><totallen>8192</totallen>'
                   '<fileext>PDF</fileext><cdnattachurl>https://example.test/media</cdnattachurl>'
                   '<aeskey>fixture</aeskey></appattach>')
        parsed = parse_rich_message(app_type(6), body)
        self.assertEqual(parsed, {"kind": "file", "title": "样本.PDF", "fileExt": "pdf", "fileBytes": 8192,
                                  "evidence": "文件：样本.PDF；类型：pdf；大小：8192 字节"})
        self.assertNotIn("fixture", str(parsed))
        unknown = parse_rich_message(app_type(6), app(6, "<title>测试</title>"))
        self.assertEqual(unknown, {"kind": "file", "title": "测试", "evidence": "文件：测试；类型：未知；大小未知"})
        self.assertFalse(valid_rich({**parsed, "fileBytes": True}))
        self.assertFalse(valid_rich({**parsed, "path": "../test.pdf"}))

    def test_image_video_location_card_and_miniprogram(self):
        fixtures = (
            (3, '<msg><img aeskey="fixture" cdnbigimgurl="fixture"/></msg>',
             {"kind": "image", "evidence": "这张图我现在看不了。"}),
            (3, "", {"kind": "image", "evidence": "这张图我现在看不了。"}),
            (43, '<msg><videomsg playlength="37" aeskey="fixture"/></msg>',
             {"kind": "video", "evidence": "视频：37 秒"}),
            (48, '<msg><location x="10" y="20" label="样本路" poiname="样本公园"/></msg>',
             {"kind": "location", "title": "样本公园", "evidence": "位置：样本公园"}),
            (42, '<msg username="fixture" nickname="示例联系人"/>',
             {"kind": "card", "title": "示例联系人", "evidence": "名片：示例联系人"}),
            (app_type(33), app(33, "<title>测试小程序</title><weappinfo><appid>fixture</appid></weappinfo>"),
             {"kind": "miniprogram", "title": "测试小程序", "evidence": "小程序：测试小程序"}),
            (app_type(36), app(36, "<title>测试小程序</title>"),
             {"kind": "miniprogram", "title": "测试小程序", "evidence": "小程序：测试小程序"}),
        )
        for raw_type, message, expected in fixtures:
            with self.subTest(raw_type=raw_type):
                self.assertEqual(parse_rich_message(raw_type, message), expected)
                self.assertTrue(valid_rich(expected, raw_type))
                self.assertNotIn("fixture", str(expected))

    def test_transfer_and_redpacket_discard_all_actionable_metadata(self):
        for subtype, name in ((2000, "transfer"), (2001, "redpacket")):
            parsed = parse_rich_message(app_type(subtype), app(
                subtype, '<title>/time</title><wcpayinfo><nativeurl>fixture</nativeurl></wcpayinfo>'))
            self.assertEqual(parsed, {"kind": name, "evidence": RICH_NOTICES[name]})
            self.assertFalse(valid_rich({**parsed, "evidence": "/time"}))
            self.assertFalse(valid_rich(parsed, app_type(5)))

    def test_oversize_entities_duplicate_fields_and_other_subtypes_are_rejected(self):
        values = (
            (app_type(5), app(5, "<url>https://example.test/" + "x" * 66_000 + "</url>")),
            (app_type(6), '<!DOCTYPE msg [<!ENTITY x "unsafe">]>' + app(6, "<title>&x;</title>")),
            (app_type(5), app(5, "<url>https://example.test/</url><url>https://again.test/</url>")),
            (app_type(57), app(57, "<title>甲</title><title>乙</title>")),
            (app_type(51), app(51, "<title>不支持的视频号卡</title>")),
            (43, "<msg><location label=\"错误类型\" /></msg>"),
        )
        for raw_type, raw in values:
            with self.subTest(raw_type=raw_type):
                self.assertIsNone(parse_rich_message(raw_type, raw))


if __name__ == "__main__":
    unittest.main()
