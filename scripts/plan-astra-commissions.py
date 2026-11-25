"""Read workbook formulas as data; only explicitly supported formulas are mapped."""
import csv,json,re,zipfile,xml.etree.ElementTree as E,unicodedata,hashlib
from fractions import Fraction
from pathlib import Path
csv_path=Path('/Users/josecorredor/Downloads/colleges_comparisson_astra.csv')
xlsx_path=Path('/Users/josecorredor/Downloads/Cover_letter_template_OFA_v7_FINAL Calude 2026.xlsx')
out=Path(__file__).resolve().parents[2]/'exports/astra-commission-review'
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
norm=lambda v:re.sub(r'\s+',' ',unicodedata.normalize('NFKC',v or '')).strip().casefold()
z=zipfile.ZipFile(xlsx_path);ss=[''.join(t.itertext()) for t in E.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',n)]
source={}
for row in E.fromstring(z.read('xl/worksheets/sheet3.xml')).findall('.//m:row',n):
 cells={}
 for cell in row:
  v=cell.find('m:v',n);f=cell.find('m:f',n)
  if v is not None or f is not None:cells[re.sub(r'\d','',cell.get('r'))]={'value':ss[int(v.text)] if cell.get('t')=='s' else v.text if v is not None else None,'formula':f.text if f is not None else None}
 if cells.get('B',{}).get('value'):source.setdefault(norm(cells['B']['value']),[]).append({'row':int(row.get('r')),'cells':cells})
rows=list(csv.DictReader(csv_path.open(encoding='utf-8-sig',newline='')))
pending={
11:'Numeric HE rates are 20%/15% for years 1/2, but notes say 15%/10%. User requested review before enabling.',
12:'Numeric HE rates are 20%/15% for years 1/2, but notes say 15%/10%. User requested review before enabling.',
15:'Cashback uses TODAY() cutoff 31 March 2026 and combines enrolment + materials without removing GST. Confirm contractual date basis and net/gross treatment before enabling.',
22:'Materials note says $90.90, formula F22 is $50/1.10. Confirm benefit amount and the eligibility distinction from the new-student rule.',
23:'Materials note says $90.90, formula F23 uses actual materials/1.10. Confirm amount and which date determines new-student eligibility after November 2025.',
60:'Numeric rate 22.73% conflicts with 25% cookery note; ELICOS/Cookery alternatives need a confirmed predicate and rate.',
61:'Numeric rate 27.27% conflicts with 25% cookery note; confirm VET exceptions and exact gross/net basis.',
94:'Fixed net bonus 181.82 is excluded for instalments, but notes add a $300 May/June Hospitality bonus. Confirm promotion year, eligibility, stacking and item mapping.',
132:'50% enrolment cashback is clear; the additional $500 for courses over 24 weeks needs confirmed commencement, once-per-course eligibility and bonus item/tax mapping.',
145:'F145 gives $1000/1.10. Historical Bonus lines exist, but frequency/once-per-enrolment eligibility is unspecified. Confirm before repeated invoice generation.',
157:'Notes add $300 VET bonus and conditional 10+2 full-price weeks; confirm frequency, credited weeks, stacking and the inconsistent historical Bonus account/tracking mapping.',
171:'Weekly formula is $20 × weeks /1.10 if tuition/week equals $180. Confirm which paid weeks qualify and representative mapping (history contains Marketing and O10).',
190:'Enrolment/1.10 formula conflicts with fixed $250 cashback note. Confirm the amount and whether it replaces or adds to percentage cashback.',
191:'Enrolment/1.10 formula conflicts with fixed $125 cashback note. Confirm the amount and whether it replaces or adds to percentage cashback.'}
plan=[]
for index,row in enumerate(rows,2):
 matches=source.get(norm(row['COLEGIO']),[]);entry={'csvRow':index,'original':row,'collegeId':row['college'][:36],'status':'Ready','rules':[]}
 if len(matches)!=1:
  entry['status']='Pending: '+('CSV associates Laneway OFF-SHORE with Acquire Training Solutions; workbook has only Laneway without OFF-SHORE. User requested identity review.' if 'laneway' in norm(row['COLEGIO']) else 'No exact workbook COLEGIO match. Confirm the source row; likely ATI AUSTRALIAN TECHNOLOGY INSTITUTE - Jimmy, but the supplied name differs.')
  plan.append(entry);continue
 src=matches[0];r=src['row'];cells=src['cells'];entry['workbookRow']=r;entry['evidence']=cells
 def val(col):return cells.get(col,{}).get('value')
 def formula(col):return cells.get(col,{}).get('formula')
 rate=Fraction(val('C') or '0')
 if formula('C'):
  if formula('C') not in ['35%/1.1','20%/1.1']:raise ValueError('Unsupported rate formula '+formula('C'))
  rate=Fraction(35 if r==150 else 20,110)
 c={'version':2,'label':row['COLEGIO'].strip(),'state':'ready','blockedReason':None,'city':None,'effectiveFrom':None,'effectiveTo':None,'dateBasis':None,'rateNumerator':rate.numerator,'rateDenominator':rate.denominator,'rateMethod':'fixed','laterRateNumerator':0,'nonBulkOnly':False,'cashback':{'mode':'none','amountMinor':0},'benefits':[]}
 name=row['COLEGIO'];classification='ELICOS' if re.search(r'\bELICOS\b',name,re.I) else 'VET' if re.search(r'\bVET\b',name,re.I) else 'HE' if re.search(r'\bHE\b',name,re.I) else None
 location='ON-SHORE' if re.search(r'\bOnshore\b',name,re.I) else 'OFF-SHORE' if re.search(r'\bOffshore\b',name,re.I) else None
 if r in [41,42]:c['city']='Adelaide'
 if r in [43,45]:c['city']='Sydney'
 if r in [33,34,196,197]:c['choiceRequired']=True
 if r in [196,197]:c['nonBulkOnly']=True
 if r==97:c.update(effectiveFrom='2018-11-01',dateBasis='enrolment_date')
 if r==127:c.update(effectiveTo='2025-03-31',dateBasis='enrolment_date')
 if r==128:c.update(effectiveFrom='2025-04-01',dateBasis='enrolment_date')
 if r==109:c.update(rateMethod='trimester',maxTrimester=4)
 if r==209:c['eligibilityNote']='Confirm the application had the agent stamp, the student commenced and paid tuition, and the invoice meets the SPI agreement requirements.'
 f=formula('D')
 if f=='Data!$B$9/1.1':c['cashback']['mode']='enrolment_gross'
 elif r==210:c['cashback']={'mode':'fixed_net','amountMinor':18182}
 elif f and r not in pending:raise ValueError('Unsupported cashback '+str(r))
 if r in [31,117]:c['benefits']=[{'source':'materials','percentageBasisPoints':10000,'gstInclusive':True,'itemCode':'MARKETING VET','saleName':'Marketing','advisorName':'O10 Open for Australia'}]
 if r==5:c['benefits']=[{'source':'materials','percentageBasisPoints':10000,'fixedAmountMinor':4545,'classification':'ELICOS','gstInclusive':False,'itemCode':'MARKETING VET','saleName':'Marketing','advisorName':'O10 Open for Australia'}]
 if r in pending:c.update(state='blocked',blockedReason=pending[r]);entry['status']='Pending: '+pending[r]
 entry['rules']=[{'classification':classification,'location':location,'program':None,'commissionBasisPoints':round(float(rate)*10000),'configuration':c}];plan.append(entry)
result={'csvSha256':hashlib.sha256(csv_path.read_bytes()).hexdigest(),'workbookSha256':hashlib.sha256(xlsx_path.read_bytes()).hexdigest(),'rows':plan}
(out/'plan.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'rows':len(plan),'ready':sum(e['status']=='Ready' for e in plan),'pending':sum(e['status']!='Ready' for e in plan),'colleges':len(set(e['collegeId'] for e in plan))}))
