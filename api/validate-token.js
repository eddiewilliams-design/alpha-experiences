const https = require('https');
const crypto = require('crypto');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function getToken(sa, cb) {
  var now = Math.floor(Date.now()/1000);
  var hdr = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var pay = b64url(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  var data = hdr+'.'+pay;
  var sig = crypto.createSign('RSA-SHA256').update(data).sign(sa.private_key,'base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  var jwt = data+'.'+sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+jwt;
  var buf = Buffer.from(body);
  var req = https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':buf.length}},function(res){
    var d='';
    res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{var r=JSON.parse(d);cb(null,r.access_token);}catch(e){cb(e);}
    });
  });
  req.on('error',cb);
  req.write(buf);
  req.end();
}

function getSheet(token, cb) {
  var path = '/v4/spreadsheets/'+SHEET_ID+'/values/Sheet1!A%3AI';
  https.get({hostname:'sheets.googleapis.com',path:path,headers:{Authorization:'Bearer '+token}},function(res){
    var d='';
    res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{cb(null,JSON.parse(d));}catch(e){cb(e);}
    });
  }).on('error',cb);
}

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  var token = (req.query.token||'').trim();
  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!token) { res.status(400).json({valid:false,reason:'no_token'}); return; }
  if (!saJson) { res.status(500).json({valid:false,reason:'config_error'}); return; }

  var sa;
  try { sa = JSON.parse(saJson); } catch(e) { res.status(500).json({valid:false,reason:'config_parse_error'}); return; }

  getToken(sa, function(err, accessToken) {
    if (err || !accessToken) { res.status(500).json({valid:false,reason:'auth_error'}); return; }
    getSheet(accessToken, function(err2, data) {
      if (err2) { res.status(500).json({valid:false,reason:'sheet_error'}); return; }
      var rows = (data && data.values) || [];
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if ((row[6]||'').trim() !== token) continue;
        if ((row[7]||'').toString().trim() !== 'TRUE') { res.status(403).json({valid:false,reason:'inactive'}); return; }
        var mode = (row[0]||'').indexOf('2 Sessions') === -1 ? 'full' : 'two';
        var name = (row[1]||'').split(' ')[0];
        res.status(200).json({valid:true,mode:mode,name:name});
        return;
      }
      res.status(404).json({valid:false,reason:'not_found'});
    });
  });
};
