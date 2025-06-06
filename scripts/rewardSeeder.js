import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import RewardItem from '../models/RewardItem.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

await mongoose.connect(process.env.MONGO_URI);

const ICONS_DIR = path.join(__dirname, '../../client/public/images'); // adjust to wherever you keep your PNGs

// 1) read all PNGs
const imageFiles = fs
  .readdirSync(ICONS_DIR)
  .filter(f => f.toLowerCase().endsWith('.png'));

// 2) map each to a RewardItem
const rewards = [
  // Arrowheads
  {
    id: 'arrowhead_09',
    name: 'Flint Arrowhead',
    image: 'arrowhead_09.png',
    description: 'A simple flint arrowhead chipped by early hunters, still sharp and sturdy.',
    category: 'weapon',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'arrowhead_01',
    name: 'Serrated Arrowhead',
    image: 'arrowhead_01.png',
    description: 'A finely serrated arrowhead designed for maximum penetration.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'arrowhead_03',
    name: 'Obsidian Arrowhead',
    image: 'arrowhead_03.png',
    description: 'A sleek obsidian arrowhead, prized for its razor-like edge.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'arrowhead_08',
    name: 'Bone Arrowhead',
    image: 'arrowhead_08.png',
    description: 'A smooth bone arrowhead, crafted with care by ancient artisans.',
    category: 'weapon',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'arrowhead_05',
    name: 'Bronze Arrowhead',
    image: 'arrowhead_05.png',
    description: 'A bronze arrowhead, showing signs of early metalworking skill.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'arrowhead_06',
    name: 'Painted Arrowhead',
    image: 'arrowhead_06.png',
    description: 'A painted arrowhead etched with tribal symbols.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'arrowhead_07',
    name: 'Carved Stone Arrowhead',
    image: 'arrowhead_07.png',
    description: 'A carved stone arrowhead with intricate designs.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'arrowhead_04',
    name: 'River-Worn Arrowhead',
    image: 'arrowhead_04.png',
    description: 'A river-worn stone arrowhead, polished by centuries of water.',
    category: 'weapon',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'arrowhead_02',
    name: 'Ceremonial Arrowhead',
    image: 'arrowhead_02.png',
    description: 'A ceremonial arrowhead adorned with delicate engravings.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 40,
  },

  // Frontier gear & tools
  {
    id: 'barrel_01',
    name: 'Wooden Barrel',
    image: 'barrel_01.png',
    description: 'A sturdy wooden barrel, perfect for storing supplies and provisions.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'crate',
    name: 'Wooden Crate',
    image: 'crate.png',
    description: 'A wooden crate used to transport goods across dangerous landscapes.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'skillet',
    name: 'Cast Iron Skillet',
    image: 'skillet.png',
    description: 'A cast iron skillet, ideal for cooking hearty meals over campfires.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'pot',
    name: 'Clay Pot',
    image: 'pot.png',
    description: 'A clay pot, sturdy enough to cook over an open fire.',
    category: 'tool',
    rarity: 'common',
    marketValue: 10,
  },

  // Clothing & wearables
  {
    id: 'boots',
    name: 'Leather Boots',
    image: 'boots.png',
    description: 'A pair of soft leather boots, built to endure long treks through rough terrain.',
    category: 'gear',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'mocassins',
    name: 'Moccasins',
    image: 'mocassins.png',
    description: 'A pair of soft moccasins, comfortable for silent steps in the wilderness.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'cowboyBoot',
    name: 'Cowboy Boot',
    image: 'cowboyBoot.png',
    description: 'A single cowboy boot, emblematic of Western trailblazers.',
    category: 'gear',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'cowboyHat',
    name: 'Cowboy Hat',
    image: 'cowboyHat.png',
    description: 'A wide-brimmed cowboy hat, shielding wearers from sun and rain.',
    category: 'gear',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'coonskinCap',
    name: 'Coonskin Cap',
    image: 'coonskinCap.png',
    description: 'A cap made from raccoon fur, a frontier favorite for warmth and style.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },

  // Instruments & decor
  {
    id: 'beadBasket',
    name: 'Bead Basket',
    image: 'beadBasket.png',
    description: 'A woven basket filled with colorful beads, used for trade and decoration.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'dreamcatcher',
    name: 'Dreamcatcher',
    image: 'dreamcatcher.png',
    description: 'A dreamcatcher woven with sinew and feathers, believed to filter out bad dreams.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'drum',
    name: 'Hand Drum',
    image: 'drum.png',
    description: 'A hand drum adorned with painted motifs, used in ceremonial gatherings.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'rattles',
    name: 'Gourd Rattles',
    image: 'rattles.png',
    description: 'A set of rattles made from gourds, used in dances and rituals.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },

  // Natural curiosities
  {
    id: 'buffalo',
    name: 'Buffalo Figurine',
    image: 'buffalo.png',
    description: 'A carved buffalo figurine, symbolizing strength and resilience.',
    category: 'trophy',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'feather',
    name: 'Eagle Feather',
    image: 'feather.png',
    description: 'A vibrant feather plucked from a rare bird of the plains.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'horseshoes',
    name: 'Horseshoes Set',
    image: 'horseshoes.png',
    description: 'A pair of horseshoes, salvaged from a seasoned mount.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10,
  },

  // Weapons & defense
  {
    id: 'knife',
    name: 'Bone Knife',
    image: 'knife.png',
    description: 'A sharp hunting knife, useful for both survival and defense.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'revolver',
    name: 'Six-Shooter Revolver',
    image: 'revolver.png',
    description: 'A classic six-shooter revolver, reliable in the heat of confrontation.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'rifle',
    name: 'Hunting Rifle',
    image: 'rifle.png',
    description: 'A long-barreled rifle, prized for its accuracy at distance.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 40,
  },

  // Badges
  {
    id: 'metalStar',
    name: 'Metal Star Badge',
    image: 'metalStar.png',
    description: 'A polished metal star once fastened to the chest of a legendary lawman.',
    category: 'trophy',
    rarity: 'legendary',
    marketValue: 100,
  },

  // Miniatures & models
  {
    id: 'ship',
    name: 'Model Ship in Bottle',
    image: 'ship.png',
    description: 'A miniature ship in a bottle, showcasing the craftsmanship of sailors.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },

  // Shelter replicas (Teepees)
  {
    id: 'teepee_01',
    name: 'Teepee Model #1',
    image: 'teepee_01.png',
    description: 'A painted teepee model with geometric patterns. Variant #1.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'teepee_02',
    name: 'Teepee Model #2',
    image: 'teepee_02.png',
    description: 'A painted teepee model with animal motifs. Variant #2.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'teepee_03',
    name: 'Teepee Model #3',
    image: 'teepee_03.png',
    description: 'A painted teepee model adorned with feather designs. Variant #3.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'teepee_04',
    name: 'Teepee Model #4',
    image: 'teepee_04.png',
    description: 'A decorated teepee model with sunset hues. Variant #4.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'teepee_05',
    name: 'Teepee Model #5',
    image: 'teepee_05.png',
    description: 'A ceremonial teepee model featuring symbolic artwork. Variant #5.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'teepee_06',
    name: 'Teepee Model #6',
    image: 'teepee_06.png',
    description: 'A traditional teepee model woven from canvas. Variant #6.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'teepee_07',
    name: 'Teepee Model #7',
    image: 'teepee_07.png',
    description: 'A ceremonial teepee model used in sacred rituals. Variant #7.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'teepee_08',
    name: 'Teepee Model #8',
    image: 'teepee_08.png',
    description: 'An ornate teepee model with tribal insignia. Variant #8.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'teepee_09',
    name: 'Teepee Model #9',
    image: 'teepee_09.png',
    description: 'A grand teepee model reserved for honored leaders. Variant #9.',
    category: 'artifact',
    rarity: 'legendary',
    marketValue: 100,
  },

  // Misc collectibles
  {
    id: 'till',
    name: 'Brass Till',
    image: 'till.png',
    description: 'A small brass till used by merchants to secure valuables.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'wagonWheel_01',
    name: 'Wagon Wheel',
    image: 'wagonWheel_01.png',
    description: 'A heavy wagon wheel salvaged from an old freight wagon.',
    category: 'tool',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'woodCarving',
    name: 'Wood Carving',
    image: 'woodCarving.png',
    description: 'A detailed wood carving depicting frontier life.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'wovenBag',
    name: 'Woven Bag',
    image: 'wovenBag.png',
    description: 'A hand-woven bag crafted from sturdy fibers, perfect for carrying goods.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  // newly added items
  {
    id: 'americanFlag',
    name: 'American Flag',
    image: 'americanFlag.png',
    description: 'A small American flag, symbolizing unity and frontier spirit.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'outhouse',
    name: 'Outhouse',
    image: 'outhouse.png',
    description: 'A weathered outhouse model, a humble relic of frontier sanitation.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 5,
  },
  {
    id: 'backpackClosed',
    name: 'Backpack',
    image: 'backpackClosed.png',
    description: 'A sturdy backpack, securely fastened, ready to carry your supplies through the maze.',
    category: 'gear',
    rarity: 'common',
    marketValue: 20,
  },
  {
    id: 'barrel_02',
    name: 'Gunpowder Barrel',
    image: 'barrel_02.png',
    description: 'A gunpowder barrel bound with metal hoops, built to withstand rough travel.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'brandingIron',
    name: 'Branding Iron',
    image: 'brandingIron.png',
    description: 'A heated branding iron, used to mark livestock or claim ownership on the frontier.',
    category: 'tool',
    rarity: 'rare',
    marketValue: 45,
  },
  {
    id: 'bugle',
    name: 'Brass Bugle',
    image: 'bugle.png',
    description: 'A brass bugle that echoes clear commands across the prairie.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 30,
  },
  {
    id: 'butterChurn',
    name: 'Butter Churn',
    image: 'butterChurn.png',
    description: 'A wooden butter churn, used to transform cream into rich butter by hand.',
    category: 'tool',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'calvaryHat',
    name: 'Calvary Hat',
    image: 'calvaryHat.png',
    description: 'A cavalry hat worn by mounted troops, its brim decorated with a regimental badge.',
    category: 'gear',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'cannon',
    name: 'Field Cannon',
    image: 'cannon.png',
    description: 'A heavy field cannon, capable of firing round shot at advancing foes.',
    category: 'weapon',
    rarity: 'rare',
    marketValue: 50,
  },
  {
    id: 'cannonBall',
    name: 'Cannon Ball',
    image: 'cannonBall.png',
    description: 'A solid iron cannon ball, the ammunition for heavy artillery.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 15,
  },
  {
    id: 'cannonBalls',
    name: 'Cannon Balls',
    image: 'cannonBalls.png',
    description: 'A handful of cannon balls, ready to be loaded into the barrel of a cannon.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'chaps',
    name: 'Leather Chaps',
    image: 'chaps.png',
    description: 'A pair of leather chaps, protecting riders from brush and weather.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 15,
  },
  {
    id: 'choppingBlock',
    name: 'Chopping Block',
    image: 'choppingBlock.png',
    description: 'A heavy chopping block, used to split firewood for campfires.',
    category: 'tool',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'cigarBox',
    name: 'Cigar Box',
    image: 'cigarBox.png',
    description: 'A polished wooden box holding fine cigars for the well-to-do officer.',
    category: 'goods',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'cigarCase',
    name: 'Cigar Case',
    image: 'cigarCase.png',
    description: 'A metal cigar case, designed to keep cigars crisp and protected.',
    category: 'goods',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'compass',
    name: 'Lucky Compass',
    image: 'compass.png',
    description: 'A finely-calibrated compass, its needle guiding you unerringly through winding passages.',
    category: 'gear',
    rarity: 'uncommon',
    marketValue: 50,
  },
  {
    id: 'custerPortrait',
    name: 'Custer Portrait',
    image: 'custerPortrait.png',
    description: 'A faded portrait of General Custer, capturing his determined gaze.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 45,
  },
  {
    id: 'gate',
    name: 'Wooden Barricade',
    image: 'gate.png',
    description: 'A sturdy wooden barricade, once guarding the entrance to an old fort.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'gloves',
    name: 'Leather Gloves',
    image: 'gloves.png',
    description: 'A pair of worn leather gloves, protecting hands from the elements.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'guitar',
    name: 'Acoustic Guitar',
    image: 'guitar.png',
    description: 'A handcrafted guitar, its strings resonating with campfire songs.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 30,
  },
  {
    id: 'hair',
    name: 'Horsehair Brush',
    image: 'hair.png',
    description: 'A brush made of horsehair, used by travelers to groom their mounts.',
    category: 'tool',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'harmonica',
    name: 'Harmonica',
    image: 'harmonica.png',
    description: 'A small harmonica, capable of filling the silence with soulful melodies.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'hoofPrint',
    name: 'Hoof Print',
    image: 'hoofPrint.png',
    description: 'A preserved hoof print, evidence of a wild stallion’s passing.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'kettle',
    name: 'Camp Kettle',
    image: 'kettle.png',
    description: 'A blackened iron kettle, used to boil water and cook stews over the fire.',
    category: 'tool',
    rarity: 'common',
    marketValue: 15,
  },
  {
    id: 'lantern',
    name: 'Oil Lantern',
    image: 'lantern.png',
    description: 'An oil lantern that burns with a steady flame, lighting the darkest nights.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 30,
  },
  {
    id: 'logCabin',
    name: 'Log Cabin Model',
    image: 'logCabin.png',
    description: 'A miniature log cabin, a reminder of simple homesteads on the prairie.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'map',
    name: 'Map',
    image: 'map.png',
    description: 'An old, hand-drawn map showing trails and landmarks long forgotten.',
    category: 'tool',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'mug',
    name: 'Tin Mug',
    image: 'mug.png',
    description: 'A sturdy tin mug, chipped from years of campfire coffee.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'navajoBlanket',
    name: 'Navajo Blanket',
    image: 'navajoBlanket.png',
    description: 'A handwoven Navajo blanket, its patterns rich with cultural heritage.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 45,
  },
  {
    id: 'oldMap',
    name: 'Ancient Map',
    image: 'oldMap.png',
    description: 'An ancient parchment map, its edges frayed and ink faded by time.',
    category: 'artifact',
    rarity: 'legendary',
    marketValue: 100,
  },
  {
    id: 'playingCard',
    name: 'Playing Card',
    image: 'playingCard.png',
    description: 'A single playing card with a bullet hole.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 5,
  },
  {
    id: 'ration',
    name: 'Ration Pack',
    image: 'ration.png',
    description: 'A dried ration pack, containing enough provisions for a single traveler.',
    category: 'consumable',
    rarity: 'uncommon',
    marketValue: 20,
  },
  {
    id: 'satchels',
    name: 'Leather Satchels',
    image: 'satchels.png',
    description: 'A pair of leather satchels, ideal for carrying maps and small tools.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 30,
  },
  {
    id: 'skunkskin',
    name: 'Skunk Skin',
    image: 'skunkskin.png',
    description: 'A preserved skunk pelt, its fur surprisingly soft despite its pungent origin.',
    category: 'goods',
    rarity: 'rare',
    marketValue: 35,
  },
  {
    id: 'surveyor',
    name: 'Surveyor’s Toolset',
    image: 'surveyor.png',
    description: 'A surveyor’s toolset complete with compass and measuring instruments.',
    category: 'tool',
    rarity: 'rare',
    marketValue: 45,
  },
  {
    id: 'sword',
    name: 'Frontier Sword',
    image: 'sword.png',
    description: 'A short sword favored by scouts for its balance of speed and reach.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 40,
  },
  {
    id: 'tower',
    name: 'Watchtower Model',
    image: 'tower.png',
    description: 'A small model of a watchtower, used by settlers to guard against threats.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 50,
  },
  {
    id: 'trailSign_01',
    name: 'Trail Sign #1',
    image: 'trailSign_01.png',
    description: 'A wooden trail sign pointing toward distant settlements.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'trailSign_02',
    name: 'Trail Sign #2',
    image: 'trailSign_02.png',
    description: 'A weathered trail sign marked with faded directions.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 10,
  },
  {
    id: 'uniform',
    name: 'Soldier Uniform',
    image: 'uniform.png',
    description: 'A well-worn soldier’s uniform, bearing the insignia of the frontier outpost.',
    category: 'gear',
    rarity: 'rare',
    marketValue: 40,
  },
  {
    id: 'wagonWheel_03',
    name: 'Broken Wagon Wheel',
    image: 'wagonWheel_03.png',
    description: 'A broken wagon wheel, its spokes splintered from rough terrain.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 5,
  },
  {
    id: 'wagonWheel_02',
    name: 'Spare Wagon Wheel',
    image: 'wagonWheel_02.png',
    description: 'A spare wagon wheel, ready to replace a damaged one and keep journeys moving.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 25,
  },
  {
    id: 'whip',
    name: 'Riding Whip',
    image: 'whip.png',
    description: 'A leather riding whip, used to guide mounts with a crack of sound.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 30,
  },
  {
    id: 'animalSkinCanoe',
    name: 'Canoe',
    image: 'animalSkinCanoe.png',
    description: 'A lightweight canoe crafted from stretched animal hide over a wooden frame, prized by river explorers for its agility and portability.',
    category: 'tool',
    rarity: 'rare',
    marketValue: 80
  },
  {
    id: 'bearHead',
    name: 'Bear',
    image: 'bearHead.png',
    description: 'The mounted head of a grizzly bear, a grim trophy symbolizing the hunter’s prowess on the frontier.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 25
  },
  {
    id: 'blueBonnet',
    name: 'Blue Bonnet',
    image: 'blueBonnet.png',
    description: 'A simple cloth bonnet dyed a deep blue, worn by pioneers to shield them from the sun.',
    category: 'gear',
    rarity: 'common',
    marketValue: 10
  },
  {
    id: 'bowArrow',
    name: 'Bow and Arrow',
    image: 'bowArrow.png',
    description: 'A handcrafted wooden bow, essential for hunting in the wilderness.',
    category: 'weapon',
    rarity: 'uncommon',
    marketValue: 15
  },
  {
    id: 'chickenHead',
    name: 'Chicken',
    image: 'chickenHead.png',
    description: 'A carved wooden chicken head, often used as a roadhouse sign or decorative trinket.',
    category: 'trophy',
    rarity: 'common',
    marketValue: 5
  },
  {
    id: 'circularSawBlade',
    name: 'Circular Saw Blade',
    image: 'circularSawBlade.png',
    description: 'A rusty blade from a 19th-century sawmill, weathered after years of use.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 30
  },
  {
    id: 'cornhuskDoll',
    name: 'Cornhusk Doll',
    image: 'cornhuskDoll.png',
    description: 'A simple doll woven from dried cornhusks, a beloved plaything fashioned by pioneer children.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 8
  },
  {
    id: 'coveredWagon',
    name: 'Covered Wagon Model',
    image: 'coveredWagon.png',
    description: 'A miniature replica of a prairie schooner, complete with canvas cover and wooden wheels.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 90
  },
  {
    id: 'duckDecoy',
    name: 'Wooden Duck Decoy',
    image: 'duckDecoy.png',
    description: 'A hand-painted decoy carved to lure waterfowl within range of hunters.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 20
  },
  {
    id: 'foxHead',
    name: 'Fox',
    image: 'foxHead.png',
    description: 'A cunning red fox’s mounted head, its glass eyes still reflecting a sly intelligence.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 25
  },
  {
    id: 'goldPocketwatch',
    name: 'Gold Pocket Watch',
    image: 'goldPocketwatch.png',
    description: 'An ornate gold pocket watch, its cover engraved with scrolling filigree and still keeping perfect time.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 85
  },
  {
    id: 'horseHead',
    name: 'Horse',
    image: 'horseHead.png',
    description: 'The carved head of a steed, perhaps once part of a carousel or a decorative sign.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 30
  },
  {
    id: 'leatherboundDiary',
    name: 'Diary',
    image: 'leatherboundDiary.png',
    description: 'A small journal bound in worn leather, its yellowed pages filled with a traveler’s daily musings.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 40
  },
  {
    id: 'leatherboundTrunk',
    name: 'Trunk',
    image: 'leatherboundTrunk.png',
    description: 'A sturdy trunk wrapped in tanned leather, used to carry a settler’s most precious belongings.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 45
  },
  {
    id: 'medicineBottleDrTibbette',
    name: 'Dr. Tibbette’s Medicine Bottle',
    image: 'medicineBottleDrTibbette.png',
    description: 'A green glass bottle labeled “Dr. Tibbette’s Elixir,” rumored to cure everything from aches to heartbreak.',
    category: 'goods',
    rarity: 'uncommon',
    marketValue: 35
  },
  {
    id: 'owlHead',
    name: 'Owl',
    image: 'owlHead.png',
    description: 'A taxidermy owl head, its feathers still soft and its stare hauntingly lifelike.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 25
  },
  {
    id: 'oxHead',
    name: 'Ox',
    image: 'oxHead.png',
    description: 'A mounted ox skull with horns, once a fixture in a rancher’s lodge.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 30
  },
  {
    id: 'peacePipeWithFeather',
    name: 'Peace Pipe',
    image: 'peacePipeWithFeather.png',
    description: 'A ceremonial pipe carved from white stone, adorned with a single eagle feather, used in sacred rituals.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 70
  },
  {
    id: 'photoLocket',
    name: 'Photo Locket',
    image: 'photoLocket.png',
    description: 'A small locket containing a sepia-toned portrait, a cherished keepsake of a loved one.',
    category: 'artifact',
    rarity: 'uncommon',
    marketValue: 50
  },
  {
    id: 'racoon',
    name: 'Racoon',
    image: 'racoon.png',
    description: 'A taxidermy racoon head, its striped fur preserved with meticulous care.',
    category: 'trophy',
    rarity: 'common',
    marketValue: 12
  },
  {
    id: 'ramHead',
    name: 'Ram',
    image: 'ramHead.png',
    description: 'A bleached ram skull, its curved horns still intact, often displayed as a rustic decoration.',
    category: 'trophy',
    rarity: 'uncommon',
    marketValue: 30
  },
  {
    id: 'silverSheriffBade',
    name: 'Silver Badge',
    image: 'silverSheriffBade.png',
    description: 'A polished silver star badge worn by the town sheriff.',
    category: 'trophy',
    rarity: 'rare',
    marketValue: 65
  },
  {
    id: 'twoManSaw',
    name: 'Two-Man Saw',
    image: 'twoManSaw.png',
    description: 'A long steel blade with handles on each end, requiring two lumberjacks to fell the largest trees.',
    category: 'tool',
    rarity: 'uncommon',
    marketValue: 28
  },
  {
    id: 'wantedPoster',
    name: 'Wanted Poster',
    image: 'wantedPoster.png',
    description: 'A weatherworn poster offering a reward for a notorious outlaw, edges frayed from exposure.',
    category: 'artifact',
    rarity: 'common',
    marketValue: 15
  },
  {
    id: 'waxSealedWarCorrespondance',
    name: 'War Correspondence',
    image: 'waxSealedWarCorrespondance.png',
    description: 'A folded letter bearing the seal of military command, its contents unknown.',
    category: 'artifact',
    rarity: 'rare',
    marketValue: 60
  },
  {
    id: 'whiskeyFlaskGlass',
    name: 'Whiskey',
    image: 'whiskeyFlaskGlass.png',
    description: 'A brass hip flask, used for sharing a dram by the campfire.',
    category: 'goods',
    rarity: 'uncommon',
    marketValue: 30
  }  
];


try {
  await RewardItem.deleteMany({});
  await RewardItem.insertMany(rewards);
  console.log('✅ Reward items seeded!');
  process.exit(0);
} catch (err) {
  console.error('❌ Seed failed:', err);
  process.exit(1);
}
