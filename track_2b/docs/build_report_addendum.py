"""Append the implementation update to the unchanged first five pilot pages."""
from io import BytesIO
from pathlib import Path
from pypdf import PdfReader,PdfWriter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet,ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
ROOT=Path(__file__).resolve().parents[1]
def build():
    target=ROOT/'LainBrain_Report.pdf';original=PdfReader(target)
    pdfmetrics.registerFont(TTFont('UpdateSans','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
    pdfmetrics.registerFont(TTFont('UpdateSansBold','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
    pdfmetrics.registerFontFamily('UpdateSans',normal='UpdateSans',bold='UpdateSansBold',italic='UpdateSans',boldItalic='UpdateSansBold')
    styles=getSampleStyleSheet()
    styles['Heading1'].fontName='UpdateSansBold'
    styles.add(ParagraphStyle(name='BodyUpdate',fontName='UpdateSans',fontSize=9.4,leading=13.4,spaceAfter=8))
    styles.add(ParagraphStyle(name='UpdateHeading',fontName='UpdateSansBold',fontSize=11.5,leading=16,spaceBefore=8,spaceAfter=6,textColor=colors.HexColor('#174b60')))
    story=[]
    def text(s,kind='BodyUpdate'):story.append(Paragraph(s,styles[kind]))
    text('5. Implementation and validation update','Heading1')
    text('15 October 2026 | Track 2B | Lain Brain | epsilon-lain')
    text('Runnable prototype and target architecture','UpdateHeading')
    text('The submission adds an English browser interface, a Python server and a Docker entry point: <b>make run</b>, then http://localhost:7860. Without a key it displays clearly labelled recorded evidence. With LLM_NAME, LLM_BASE_URL and LLM_API_KEY configured, an explicit live button starts a capped Apertus run. Raw responses precede grading; actual model actions and saved note versions remain inspectable.')
    text('<b>Target c: sovereign Swiss cloud.</b> Model inference uses CSCS in Switzerland. The operator hosts the application and output storage; an organizational deployment must also locate these within its required Swiss residency boundary. The current local application is not a certified sovereign production deployment. Self-hosted and air-gapped model serving were not validated. Build dependencies include a Python 3.12 Docker base image; the application itself uses the standard library.')
    text('Fresh implementation smoke: success and failure','UpdateHeading')
    text('Two new 70B runs produced 14 saved responses, separate from the frozen 63-response evaluation. In the 435 case the model computed ZERO versus POSITIVE, chose RETRACT and wrote the verified replacement 435 * v ** 2. The old note produced a wrong later answer; the revised-note and no-note final answers were correct.')
    text('The correct 315 control computed ZERO on both sides but still chose RETRACT, reasoning that one agreeing input did not prove an identity. Its replacement was equivalent and all later final answers were correct. Nevertheless, withdrawing a correct note without a grounded contradiction is a <b>preservation failure</b>. The original responses and decision are retained. These runs do not change the earlier frozen control score of 0/2 mistaken withdrawals.')
    text('A display field originally conflated full-output acceptance with final-expression correctness. A separate analysis now reports both; original sealed records remain unchanged. Long explanations can have a correct extracted final formula while failing the stricter output interface.')
    text('Executed checks, evidence and model publication','UpdateHeading')
    text('Local checks cover archive integrity, seal tampering, private configuration, request-failure receipts, exact replacement checks, HTTP endpoints and checkpoint-export bounds. The original audit verifies 245 real responses and 576 sealed JSON records. New smoke records are supplied separately. Docker is unavailable in the authoring environment; the included GitHub Actions workflow builds and smoke-tests it. A supplied Dockerfile alone is not a passed container run; consult docs/Validation.json for current status.')
    text('The repository also includes the historical 0.5B conditional-training runner and an explicit checkpoint inventory/export tool. Actual student weights remain in the original training Notebook and are not bundled or represented as a standard PEFT adapter. No API model weights were updated. The 110-second English-captioned video is a recorded-evidence walkthrough, with no simulated live inference or training.')
    text('Report license: CC-BY-4.0. Third-party source/model licenses are retained separately.')
    buf=BytesIO()
    def footer(canvas,doc):
        canvas.setFont('UpdateSans',8);canvas.setFillColor(colors.HexColor('#566677'))
        canvas.drawString(42,26,'Lain ZIP | Implementation update | epsilon-lain');canvas.drawRightString(553,26,'6')
    doc=SimpleDocTemplate(buf,pagesize=(595.276,841.89),rightMargin=42,leftMargin=42,topMargin=40,bottomMargin=44)
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    update=PdfReader(buf);assert len(update.pages)==1,'Addendum exceeds one page'
    writer=PdfWriter()
    for p in list(original.pages)[:5]:writer.add_page(p)
    writer.add_page(update.pages[0]);writer.add_metadata({'/Title':'Lain ZIP: Checkable and Revisable Memory for Apertus','/Author':'epsilon-lain'})
    with target.open('wb') as stream:writer.write(stream)
    assert len(PdfReader(target).pages)==6
    print(str(target))
if __name__=='__main__':build()
