/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * eval/s2v2-lexicon.js — small bundled wordlist/namelist for the S2v2
 * value-symmetry audit (GPT audit #6/#10).
 *
 * A hit is a FLAG, never an auto-fail. Re-selection of a flagged value is a
 * human freeze-time decision. Do not silently swap fixtures because of a hit.
 *
 * named_priors are the tokens GPT named to scrutinize; they always surface
 * even if they would also match the generic lists.
 */

"use strict";

const NAMED_PRIORS = {
  sorin: "Romanian given name (GPT audit #6/#10)",
  velka: "Czech/Slovak velka 'great' (GPT audit #6/#10)",
  yulka: "Slavic diminutive of Yulia (GPT audit #6/#10)",
  porin: "protein name / recognizable lexical item (GPT audit #6/#10)",
};

// Compact English list aimed at the slip classes this corpus could make:
// color/material/lining words, common 3–10 letter words, household nouns.
const ENGLISH_WORDS = [
  "able","about","above","across","act","add","after","again","against","age",
  "ago","agree","ahead","air","all","allow","almost","alone","along","already",
  "also","always","among","amount","and","animal","another","answer","any",
  "anyone","anything","anyway","appear","apple","apply","area","argue","arm",
  "around","arrive","art","article","ask","away","baby","back","bad","bag",
  "ball","bank","bar","base","basic","bath","be","bear","beat","beautiful",
  "because","become","bed","been","before","begin","behind","being","believe",
  "bell","below","bend","best","better","between","beyond","big","bill","bind",
  "bird","bit","black","block","blood","blow","blue","board","boat","body",
  "bond","bone","book","boot","border","born","both","bottle","bottom","bought",
  "box","boy","branch","brand","bread","break","bridge","brief","bright","bring",
  "broad","broke","brown","brush","build","built","burn","bus","busy","but",
  "button","buy","by","call","came","camp","can","canvas","cap","car","card",
  "care","carry","case","catch","cause","cell","center","central","century",
  "certain","chair","chance","change","charge","cheap","check","chest","child",
  "choice","choose","church","circle","city","claim","class","clean","clear",
  "climb","clock","close","cloth","cloud","club","coat","code","coffee","cold",
  "color","colour","come","common","company","compare","complete","computer",
  "concern","condition","consider","contain","continue","control","cook","cool",
  "copy","corn","corner","correct","cost","cotton","could","count","country",
  "course","cover","cream","create","cross","crowd","cry","cup","current","cut",
  "daily","damage","dance","danger","dark","data","date","daughter","day","dead",
  "deal","dear","death","decide","deep","degree","demand","design","desk",
  "detail","determine","develop","die","difference","different","difficult",
  "dinner","direct","direction","discover","discuss","distance","divide","do",
  "doctor","dog","door","double","doubt","down","draw","dream","dress","drink",
  "drive","drop","dry","during","dust","each","ear","early","earth","ease",
  "east","easy","eat","edge","effect","effort","eight","either","else","empty",
  "end","enemy","energy","engine","enjoy","enough","enter","entire","equal",
  "especially","even","evening","event","ever","every","everyone","everything",
  "evidence","exact","example","except","exist","expect","experience","explain",
  "eye","face","fact","fail","fall","family","far","farm","fast","father",
  "fear","feel","feeling","felt","few","field","fight","figure","fill","film",
  "final","find","fine","finger","finish","fire","firm","first","fish","fit",
  "five","fix","flag","flat","floor","flow","flower","fly","foam","follow",
  "food","foot","for","force","forest","forget","form","former","forward",
  "found","four","frame","free","fresh","friend","from","front","full","fun",
  "future","game","garden","gas","gate","gather","gave","general","get","girl",
  "give","glass","go","god","gold","gone","good","got","government","grain",
  "grass","gray","great","green","grey","ground","group","grow","growth",
  "guess","guide","gun","had","hair","half","hall","hand","handle","hang",
  "happen","happy","hard","has","hat","have","he","head","health","hear",
  "heart","heat","heavy","held","help","her","here","herself","hide","high",
  "hill","him","himself","his","history","hit","hold","hole","home","hope",
  "horse","hot","hotel","hour","house","how","however","huge","human","hundred",
  "hurt","ice","idea","if","image","imagine","important","in","inch","include",
  "increase","indeed","indicate","individual","industry","ink","inside",
  "instead","interest","into","iron","is","island","issue","it","item","its",
  "itself","job","join","just","keep","key","kill","kind","king","kitchen",
  "knew","know","known","label","labor","lack","lady","laid","lake","land",
  "language","large","last","late","later","laugh","law","lay","lead","learn",
  "least","leave","led","left","leg","length","less","let","letter","level",
  "lie","life","lift","light","like","likely","limit","line","linen","link",
  "list","listen","little","live","local","lock","long","look","lose","loss",
  "lost","lot","loud","love","low","machine","made","main","major","make",
  "man","many","map","mark","market","marry","mass","master","match","material",
  "matter","may","maybe","me","mean","measure","meet","member","memory","men",
  "mention","mere","message","met","method","middle","might","mile","milk",
  "mind","mine","minute","miss","model","modern","moment","money","month",
  "more","morning","most","mother","motor","mountain","mouth","move","movement",
  "much","music","must","my","myself","name","nation","natural","nature","near",
  "nearly","necessary","need","neither","never","new","news","next","nice",
  "night","nine","no","none","nor","normal","north","not","note","nothing",
  "notice","noun","now","number","object","observe","obtain","occur","of",
  "off","offer","office","often","oil","old","on","once","one","only","onto",
  "open","operate","operation","opinion","or","order","ordinary","organize",
  "original","other","ought","our","out","outside","over","own","page","paid",
  "pain","paint","pair","paper","parent","park","part","particular","party",
  "pass","past","path","pattern","pay","peace","people","per","perhaps",
  "period","person","physical","pick","picture","piece","place","plan","plane",
  "plant","plastic","play","please","point","police","political","poor",
  "popular","position","possible","post","pound","power","practice","prepare",
  "present","president","press","pressure","pretty","prevent","price","private",
  "probably","problem","process","produce","product","production","program",
  "progress","prove","provide","public","pull","purpose","push","put",
  "quality","quarter","question","quick","quiet","quite","radio","rain",
  "raise","range","rate","rather","reach","read","ready","real","realize",
  "really","reason","receive","recent","recognize","record","red","reduce",
  "refer","region","relation","remain","remember","remove","repeat","replace",
  "reply","report","represent","require","research","result","return","rich",
  "ride","right","ring","rise","river","road","rock","roll","room","rose",
  "round","row","rule","run","rubber","safe","said","sail","salt","same",
  "sand","satin","save","saw","say","scale","scene","school","science","score",
  "sea","search","season","seat","second","secret","section","see","seed",
  "seem","seen","self","sell","send","sense","sent","sentence","separate",
  "serious","serve","service","set","settle","seven","several","shade","shadow",
  "shake","shall","shape","share","sharp","she","shelf","shell","shine","ship",
  "shirt","shock","shoe","shop","short","should","shoulder","show","side",
  "sight","sign","silk","similar","simple","since","sing","single","sir","sit",
  "six","size","skill","skin","sky","sleep","slow","small","smile","snow","so",
  "social","soft","soil","soldier","some","someone","something","sometimes",
  "son","song","soon","sort","sound","south","space","speak","special","speed",
  "spell","spend","spoke","spot","spread","spring","square","stage","stand",
  "standard","star","start","state","station","stay","steel","step","stick",
  "still","stock","stone","stood","stop","store","story","straight","strange",
  "stream","street","strength","stretch","strike","strong","student","study",
  "subject","success","such","sudden","suede","suffer","sugar","suggest","suit",
  "summer","sun","supply","support","suppose","sure","surface","system","table",
  "take","taken","talk","tall","tape","task","tax","tea","teach","team","tear",
  "tell","ten","term","test","than","thank","that","the","their","them",
  "themselves","then","there","therefore","these","they","thick","thin","thing",
  "think","third","this","those","though","thought","thousand","three","through",
  "throw","thus","tie","time","tiny","to","today","together","told","tomorrow",
  "tone","too","took","tool","top","total","touch","toward","town","track",
  "trade","train","travel","tree","trial","tried","trip","trouble","true",
  "trust","try","turn","twelve","twenty","two","type","under","understand",
  "unit","until","up","upon","us","use","used","usual","usually","value",
  "various","velvet","very","view","village","visit","voice","wait","walk",
  "wall","want","war","warm","was","wash","watch","water","wave","way","we",
  "wear","weather","week","weight","well","went","were","west","what","wheel",
  "when","where","whether","which","while","white","who","whole","whom","whose",
  "why","wide","wife","wild","will","win","wind","window","wine","wing",
  "winter","wire","wish","with","within","without","woman","women","won",
  "wonder","wood","wool","word","work","worker","world","worry","worth",
  "would","write","written","wrong","wrote","yard","year","yellow","yes",
  "yesterday","yet","you","young","your","yourself",
  // color / material / lining / household extras (corpus-shaped slip class)
  "azure","beige","black","blue","brass","bronze","brown","canvas","ceramic",
  "cherry","cobalt","copper","coral","cork","cotton","crimson","cyan","ebony",
  "enamel","felt","foam","gauze","gold","gray","green","grey","indigo","ivory",
  "khaki","lace","leather","lime","linen","magenta","mahogany","maple","maroon",
  "mint","navy","nylon","oak","ochre","olive","orange","peach","pine","pink",
  "polyester","purple","red","rust","satin","scarlet","silk","silver","steel",
  "suede","tan","teal","velvet","violet","walnut","white","wool","yellow",
  "stamp","sticker","tag","marker","lining","crate","bin","hook","shelf",
  "drawer","envelope","printer","garden","radio","callsign","stencil","tab",
];

const GIVEN_NAMES = [
  "aaron","abby","abigail","adam","adrian","agnes","alan","albert","alex",
  "alexander","alexandra","alice","alicia","alison","allen","allison","alyssa",
  "amanda","amber","amelia","amy","ana","anastasia","andrea","andrei","andrew",
  "andy","angela","angelina","anita","ann","anna","anne","annie","anthony",
  "anton","antonio","aria","ariel","arthur","ashley","audrey","austin","ava",
  "barbara","barry","beatrice","ben","benjamin","bernard","beth","betty",
  "beverly","bill","billy","blair","bob","bobby","brad","bradley","brandon",
  "brenda","brian","brianna","bruce","bryan","caleb","calvin","camila","carl",
  "carla","carlos","carol","caroline","carolyn","carrie","carter","cathy",
  "cecilia","charles","charlie","charlotte","chase","chelsea","chloe","chris",
  "christian","christina","christine","christopher","cindy","claire","clara",
  "clarence","claude","clayton","clifford","clinton","cody","colin","connie",
  "constance","corey","cory","craig","crystal","curtis","cynthia","daisy",
  "dale","dallas","damian","dan","dana","daniel","daniela","danielle","danny",
  "darrell","darren","darryl","daryl","dave","david","dawn","dean","deanna",
  "deborah","debra","denis","dennis","derek","diana","diane","diego","dolores",
  "dominic","don","donald","donna","dora","dorian","doris","dorothy","doug",
  "douglas","dragos","drew","duane","dustin","dwayne","dylan","earl","eddie",
  "edgar","edith","edmund","edward","edwin","eileen","elaine","eleanor","elena",
  "eli","elias","elijah","elisa","elisabeth","elise","eliza","elizabeth","ella",
  "ellen","ellie","elliot","elsa","elsie","emily","emma","eric","erica","erik",
  "erin","ernest","esther","ethan","eugene","eva","evan","evelyn","everett",
  "faith","faye","felix","fernando","fiona","florence","floyd","fran","frances",
  "francis","francisco","frank","franklin","fred","frederick","gabriel","gail",
  "gareth","garrett","gary","gavin","gene","geoffrey","george","georgia",
  "gerald","gina","gladys","glen","glenn","gloria","gordon","grace","graham",
  "grant","greg","gregory","gretchen","guy","gwen","hailey","hank","hanna",
  "hannah","harold","harry","harvey","hazel","heather","hector","heidi","helen",
  "helena","henry","herbert","holly","howard","hugh","hugo","ian","ida","igor",
  "inez","ingrid","ion","ira","irene","iris","irma","isaac","isabel","isabella",
  "isabelle","ivan","ivy","jack","jackie","jackson","jacob","jacqueline","jade",
  "jake","james","jamie","jan","jane","janet","janice","jared","jason","jay",
  "jean","jeanette","jeff","jeffrey","jenna","jennifer","jenny","jeremy","jerome",
  "jerry","jesse","jessica","jessie","jesus","jill","jim","jimmy","joan","joann",
  "joanna","joanne","jodi","jody","joe","joel","john","johnny","jon","jonathan",
  "jordan","jorge","jose","joseph","josephine","josh","joshua","joyce","juan",
  "judith","judy","julia","julian","julie","juliet","julio","june","justin",
  "kara","karen","karina","karl","kate","katelyn","katherine","kathleen",
  "kathryn","kathy","katie","katrina","kay","kayla","keith","kelly","ken",
  "kennedy","kenneth","kenny","kent","kevin","kim","kimberly","kirk","kristen",
  "kristin","kristina","krystal","kurt","kyle","lacey","lance","larry","laura",
  "lauren","laurie","lawrence","lea","leah","lee","leigh","lena","leo","leon",
  "leonard","leroy","leslie","lester","levi","lewis","liam","lillian","lily",
  "linda","lindsay","lisa","liz","liza","lloyd","logan","lois","lola","lonnie",
  "lora","loren","lorenzo","lori","lorraine","lou","louis","louise","lucas",
  "lucia","lucy","luis","luke","lulu","luna","lydia","lynn","mabel","mack",
  "maddy","madeleine","madeline","madison","mae","maggie","maia","malcolm",
  "mandy","manuel","marc","marcel","marcia","marco","marcus","margaret","maria",
  "mariah","marian","marie","marilyn","marina","mario","marion","marisa","mark",
  "marlene","marlon","martha","martin","martina","marvin","mary","mason","matilda",
  "matt","matthew","maureen","maurice","max","maxine","maya","megan","melanie",
  "melinda","melissa","melvin","mia","michael","michaela","michelle","miguel",
  "mike","mildred","miles","miller","milton","milos","mina","mindy","miranda",
  "miriam","misty","mitchell","molly","mona","monica","monique","morgan","morris",
  "nadia","nancy","naomi","natalia","natalie","natasha","nathan","nathaniel",
  "neal","neil","nell","nelson","nicholas","nick","nicole","nina","noah","noel",
  "nora","nolan","nora","norma","norman","olga","oliver","olivia","omar","opal",
  "oscar","otis","otto","owen","pablo","paige","pam","pamela","pat","patricia",
  "patrick","patsy","patti","patty","paul","paula","pauline","pearl","pedro",
  "peggy","penelope","penny","perry","pete","peter","phil","philip","phillip",
  "phyllis","pierre","polly","preston","priscilla","quincy","quinn","rachel",
  "ralph","ramon","ramona","randall","randolph","randy","raquel","ray","raymond",
  "rebecca","regina","reginald","reid","rene","renee","rex","rhonda","ricardo",
  "rich","richard","rick","ricky","rita","rob","robbie","robert","roberta",
  "roberto","robin","rochelle","rod","roderick","rodney","roger","roland","ron",
  "ronald","ronnie","rosa","rosalie","rose","rosemary","ross","roy","ruben",
  "ruby","rudolph","rudy","russell","ruth","ryan","sabrina","sadie","sally",
  "sam","samantha","samuel","sandra","sandy","sara","sarah","saul","scott",
  "sean","sebastian","selena","serena","sergey","seth","shannon","sharon",
  "shaun","shawn","sheila","shelley","sherri","sherry","sheryl","shirley",
  "sidney","silvia","simon","sonia","sonja","sonya","sophia","sophie","sorin",
  "stacey","stacy","stanley","stella","stephanie","stephen","steve","steven",
  "stewart","stuart","sue","susan","susanna","susanne","suzanne","sydney",
  "sylvia","tabitha","tamara","tami","tammy","tanya","tara","tasha","taylor",
  "ted","teresa","terrance","terri","terry","thelma","theodore","theresa",
  "thomas","tiffany","tim","timothy","tina","todd","tom","tommy","toni","tony",
  "tracey","traci","tracy","travis","trent","trevor","troy","tyler","tyrone",
  "tyson","ulysses","ursula","valerie","vanessa","vera","vernon","veronica",
  "vicki","vicky","victor","victoria","vincent","viola","violet","virgil",
  "virginia","vivian","wade","walker","wallace","walter","wanda","warren",
  "wayne","wendy","wesley","whitney","will","willa","william","willie","wilson",
  "winfred","winston","wyatt","xavier","yolanda","yulia","yulka","yvette",
  "yvonne","zachary","zach","zoe","zoey",
];

const ENGLISH_SET = new Set(ENGLISH_WORDS.map((w) => w.toLowerCase()));
const NAME_SET = new Set(GIVEN_NAMES.map((w) => w.toLowerCase()));

function lookupLexical(value) {
  const k = String(value == null ? "" : value).trim().toLowerCase();
  if (!k) return { hit: false, kind: null, detail: null, key: k };
  if (Object.prototype.hasOwnProperty.call(NAMED_PRIORS, k)) {
    return { hit: true, kind: "named_prior", detail: NAMED_PRIORS[k], key: k };
  }
  if (NAME_SET.has(k)) {
    return { hit: true, kind: "given_name", detail: "recognizable given name", key: k };
  }
  if (ENGLISH_SET.has(k)) {
    return { hit: true, kind: "english_word", detail: "English word", key: k };
  }
  return { hit: false, kind: null, detail: null, key: k };
}

module.exports = {
  NAMED_PRIORS,
  ENGLISH_WORDS,
  GIVEN_NAMES,
  lookupLexical,
};
