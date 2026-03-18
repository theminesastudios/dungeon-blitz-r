package
{
   import flash.filters.GlowFilter;
   import flash.geom.Point;
   
   public class LinkUpdater
   {
      
      public static const MIN_TIME_BETWEEN_UPDATES:uint = 125;
      
      public static const MIN_TIME_BETWEEN_POS_UPDATES:uint = 1000;
      
      public static const VELOCITY_INFLATE:uint = 10000;
      
      public static const VELOCITY_DEFLATE:Number = 0.0001;
      
      private static const DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE:uint = 24;
      
      public static const const_1264:String = "localhost";
      
      private static var TYPE_ITERATOR:uint = Connection.const_868;
      
      public static const PKTTYPE_ENT_INCREMENTAL_UPDATE:uint = 7;
      
      public static const PKTTYPE_ENT_FULL_UPDATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ENT_POWER_CAST:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ENT_POWER_HIT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ENT_ADD_BUFF:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ENT_REMOVE_BUFF:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ENT_DESTROY:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_PROJECTILE_EXPLODE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_NEWLY_RELEVANT_ENTITY:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_WELCOME:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_VERSION:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_CHALLENGE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_CREATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_AUTHENTICATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_CHARACTER_LIST:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_CHARACTER_SELECT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_CHARACTER_CREATE:uint = TYPE_ITERATOR++;
      
      public static const const_933:uint = TYPE_ITERATOR++;
      
      public static const const_840:uint = TYPE_ITERATOR++;
      
      public static const const_1263:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_FAILURE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TRANSFER_BEGIN:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TRANSFER_READY:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_MASTER_CLIENT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAMESERVER_LOGIN:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_TO_GAME_LOAD_LEVEL:uint = TYPE_ITERATOR++;
      
      public static const const_945:uint = TYPE_ITERATOR++;
      
      public static const const_1321:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_MASTER_PORT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_MASTER_START_LEVEL:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_MASTER_END_LEVEL:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_LOGIN_READY:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_LOGIN_USER_JOINED:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_LOGIN_USER_LEFT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_LOGIN_MAP_CLOSED:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GRANT_REWARD:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECEIVE_REWARD:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CHAT_MESSAGE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_OPEN_DOOR:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_DOOR_TARGET:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GAME_TO_LOGIN_USER_TRANSFER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_UPDATE_EQUIPMENT:uint = TYPE_ITERATOR++;
      
      public static const const_1029:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECEIVE_LOOTDROP:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECEIVE_GEAR:uint = TYPE_ITERATOR++;
      
      public static const const_1010:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECEIVE_GOLD:uint = TYPE_ITERATOR++;
      
      public static const const_956:uint = TYPE_ITERATOR++;
      
      public static const const_1134:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_PICKUP_LOOTDROP:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CHANGE_LEVEL:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SERVER_ADJUST_HP:uint = TYPE_ITERATOR++;
      
      public static const const_1271:uint = TYPE_ITERATOR++;
      
      public static const const_905:uint = TYPE_ITERATOR++;
      
      public static const const_1141:uint = TYPE_ITERATOR++;
      
      public static const const_894:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SET_LEVEL_COMPLETE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LEVEL_STATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_REQUEST_DOOR_STATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_DOOR_STATE:uint = TYPE_ITERATOR++;
      
      public static const const_1039:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CHAT_STATUS:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_TO_GAME_KICK_USER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SEND_CHAT_PRIVATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECV_CHAT_PRIVATE:uint = TYPE_ITERATOR++;
      
      public static const const_1183:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RELAY_TO_CHARID:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RELAY_TO_CHARNAME:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RELAY_PACKET_PROCESS:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RELAY_PACKET_SENDTOCLIENT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_CREATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_DISBAND:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_INVITE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_KICK:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_PROMOTE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_DEMOTE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_LEADER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GUILD_QUIT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CLEAR_GUILDCACHE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GUILD_UPDATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GUILD_REFRESH_MEMBERSHIP:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_QUERYMESSAGE_QUESTION:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_QUERYMESSAGE_ANSWER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_QUERYMESSAGE_INTERPRET:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_TO_GAME_NOTIFY_ONLINE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_LOGIN_TO_GAME_NOTIFY_OFFLINE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ONLINE_USER_GUILD_STATUS:uint = TYPE_ITERATOR++;
      
      public static const const_1377:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SEND_CHAT_GUILD:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECV_CHAT_GUILD:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SEND_CHAT_OFFICER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECV_CHAT_OFFICER:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_SEND_CHAT_GROUP:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECV_CHAT_GROUP:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GROUP_INVITE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GROUP_LEAVE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GROUP_KICK:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CMD_GROUP_LEADER:uint = TYPE_ITERATOR++;
      
      public static const const_707:uint = TYPE_ITERATOR++;
      
      public static const const_1020:uint = TYPE_ITERATOR++;
      
      public static const const_1276:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TOLOGIN_GROUP_INVITE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TOLOGIN_GROUP_ADD:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TOLOGIN_GROUP_REMOVE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TOLOGIN_GROUP_LEADER:uint = TYPE_ITERATOR++;
      
      public static const const_1397:uint = TYPE_ITERATOR++;
      
      public static const const_1337:uint = TYPE_ITERATOR++;
      
      public static const const_1329:uint = TYPE_ITERATOR++;
      
      public static const const_1347:uint = TYPE_ITERATOR++;
      
      public static const const_1306:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_GROUP_UPDATE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_ROOM_THOUGHT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_REQUEST_RESPAWN:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CHAR_REGEN:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_BUFF_TICK_DOT:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_TALK_TO_NPC:uint = TYPE_ITERATOR++;
      
      public static const const_1065:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CLIENT_ERROR:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_CHANGE_OFFSET_Y:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_EMOTE_BEGIN:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_EMOTE_END:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RESPAWN_COMPLETE:uint = TYPE_ITERATOR++;
      
      public static const const_839:uint = TYPE_ITERATOR++;
      
      public static const const_743:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_MISSION_PROGRESS:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_MISSION_COMPLETE:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_MISSION_ADDED:uint = TYPE_ITERATOR++;
      
      public static const const_990:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_RECV_LEVEL_COMPLETE:uint = TYPE_ITERATOR++;
      
      public static const const_1126:uint = TYPE_ITERATOR++;
      
      public static const const_1031:uint = TYPE_ITERATOR++;
      
      public static const const_760:uint = TYPE_ITERATOR++;
      
      public static const const_874:uint = TYPE_ITERATOR++;
      
      public static const const_876:uint = TYPE_ITERATOR++;
      
      public static const const_1161:uint = TYPE_ITERATOR++;
      
      public static const const_1152:uint = TYPE_ITERATOR++;
      
      public static const const_941:uint = TYPE_ITERATOR++;
      
      public static const const_616:uint = TYPE_ITERATOR++;
      
      public static const const_610:uint = TYPE_ITERATOR++;
      
      public static const const_1298:uint = TYPE_ITERATOR++;
      
      public static const PKTTYPE_FRIEND_REMOVED:uint = TYPE_ITERATOR++;
      
      public static const const_1368:uint = TYPE_ITERATOR++;
      
      public static const const_1302:uint = TYPE_ITERATOR++;
      
      public static const const_1256:uint = TYPE_ITERATOR++;
      
      public static const const_879:uint = TYPE_ITERATOR++;
      
      public static const const_901:uint = TYPE_ITERATOR++;
      
      public static const const_1260:uint = TYPE_ITERATOR++;
      
      public static const const_1008:uint = TYPE_ITERATOR++;
      
      public static const const_1112:uint = TYPE_ITERATOR++;
      
      public static const const_1229:uint = TYPE_ITERATOR++;
      
      public static const const_1165:uint = TYPE_ITERATOR++;
      
      public static const const_1052:uint = TYPE_ITERATOR++;
      
      public static const const_1241:uint = TYPE_ITERATOR++;
      
      public static const const_1348:uint = TYPE_ITERATOR++;
      
      public static const const_1157:uint = TYPE_ITERATOR++;
      
      public static const const_1090:uint = TYPE_ITERATOR++;
      
      public static const const_1171:uint = TYPE_ITERATOR++;
      
      public static const const_924:uint = TYPE_ITERATOR++;
      
      public static const const_683:uint = TYPE_ITERATOR++;
      
      public static const const_762:uint = TYPE_ITERATOR++;
      
      public static const const_808:uint = TYPE_ITERATOR++;
      
      public static const const_716:uint = TYPE_ITERATOR++;
      
      public static const const_648:uint = TYPE_ITERATOR++;
      
      public static const const_617:uint = TYPE_ITERATOR++;
      
      public static const const_788:uint = TYPE_ITERATOR++;
      
      public static const const_805:uint = TYPE_ITERATOR++;
      
      public static const const_823:uint = TYPE_ITERATOR++;
      
      public static const const_691:uint = TYPE_ITERATOR++;
      
      public static const const_1061:uint = TYPE_ITERATOR++;
      
      public static const const_773:uint = TYPE_ITERATOR++;
      
      public static const const_937:uint = TYPE_ITERATOR++;
      
      public static const const_709:uint = TYPE_ITERATOR++;
      
      public static const const_1209:uint = TYPE_ITERATOR++;
      
      public static const const_1235:uint = TYPE_ITERATOR++;
      
      public static const const_1028:uint = TYPE_ITERATOR++;
      
      public static const const_897:uint = TYPE_ITERATOR++;
      
      public static const const_791:uint = TYPE_ITERATOR++;
      
      public static const const_1353:uint = TYPE_ITERATOR++;
      
      public static const const_1358:uint = TYPE_ITERATOR++;
      
      public static const const_1175:uint = TYPE_ITERATOR++;
      
      public static const const_1127:uint = TYPE_ITERATOR++;
      
      public static const const_1014:uint = TYPE_ITERATOR++;
      
      public static const const_929:uint = TYPE_ITERATOR++;
      
      public static const const_1077:uint = TYPE_ITERATOR++;
      
      public static const const_966:uint = TYPE_ITERATOR++;
      
      public static const const_1133:uint = TYPE_ITERATOR++;
      
      public static const const_1137:uint = TYPE_ITERATOR++;
      
      public static const const_694:uint = TYPE_ITERATOR++;
      
      public static const const_767:uint = TYPE_ITERATOR++;
      
      public static const const_1208:uint = TYPE_ITERATOR++;
      
      public static const const_451:uint = TYPE_ITERATOR++;
      
      public static const const_893:uint = TYPE_ITERATOR++;
      
      public static const const_843:uint = TYPE_ITERATOR++;
      
      public static const const_976:uint = TYPE_ITERATOR++;
      
      public static const const_913:uint = TYPE_ITERATOR++;
      
      public static const const_1178:uint = TYPE_ITERATOR++;
      
      public static const const_1300:uint = TYPE_ITERATOR++;
      
      public static const const_1239:uint = TYPE_ITERATOR++;
      
      public static const const_1153:uint = TYPE_ITERATOR++;
      
      public static const const_1415:uint = TYPE_ITERATOR++;
      
      public static const const_1105:uint = TYPE_ITERATOR++;
      
      public static const const_1273:uint = TYPE_ITERATOR++;
      
      public static const const_1205:uint = TYPE_ITERATOR++;
      
      public static const const_1089:uint = TYPE_ITERATOR++;
      
      public static const const_1047:uint = TYPE_ITERATOR++;
      
      public static const const_1044:uint = TYPE_ITERATOR++;
      
      public static const const_920:uint = TYPE_ITERATOR++;
      
      public static const const_987:uint = TYPE_ITERATOR++;
      
      public static const const_861:uint = TYPE_ITERATOR++;
      
      public static const const_838:uint = TYPE_ITERATOR++;
      
      public static const const_878:uint = TYPE_ITERATOR++;
      
      public static const const_1158:uint = TYPE_ITERATOR++;
      
      public static const const_1032:uint = TYPE_ITERATOR++;
      
      public static const const_1187:uint = TYPE_ITERATOR++;
      
      public static const const_1129:uint = TYPE_ITERATOR++;
      
      public static const const_1111:uint = TYPE_ITERATOR++;
      
      public static const const_1220:uint = TYPE_ITERATOR++;
      
      public static const const_1284:uint = TYPE_ITERATOR++;
      
      public static const const_1192:uint = TYPE_ITERATOR++;
      
      public static const const_889:uint = TYPE_ITERATOR++;
      
      public static const const_1027:uint = TYPE_ITERATOR++;
      
      public static const const_849:uint = TYPE_ITERATOR++;
      
      public static const const_981:uint = TYPE_ITERATOR++;
      
      public static const const_947:uint = TYPE_ITERATOR++;
      
      public static const const_939:uint = TYPE_ITERATOR++;
      
      public static const const_877:uint = TYPE_ITERATOR++;
      
      public static const const_1190:uint = TYPE_ITERATOR++;
      
      public static const const_978:uint = TYPE_ITERATOR++;
      
      public static const const_1369:uint = TYPE_ITERATOR++;
      
      public static const const_1114:uint = TYPE_ITERATOR++;
      
      public static const const_1036:uint = TYPE_ITERATOR++;
      
      public static const const_962:uint = TYPE_ITERATOR++;
      
      public static const const_1081:uint = TYPE_ITERATOR++;
      
      public static const const_1262:uint = TYPE_ITERATOR++;
      
      public static const const_928:uint = TYPE_ITERATOR++;
      
      public static const const_1104:uint = TYPE_ITERATOR++;
      
      public static const const_1197:uint = TYPE_ITERATOR++;
      
      public static const const_996:uint = TYPE_ITERATOR++;
      
      public static const const_1280:uint = TYPE_ITERATOR++;
      
      public static const const_1099:uint = TYPE_ITERATOR++;
      
      public static const const_1142:uint = TYPE_ITERATOR++;
      
      public static const const_900:uint = TYPE_ITERATOR++;
      
      public static const const_1037:uint = TYPE_ITERATOR++;
      
      public static const const_975:uint = TYPE_ITERATOR++;
      
      public static const const_1255:uint = TYPE_ITERATOR++;
      
      public static const const_969:uint = TYPE_ITERATOR++;
      
      public static const const_1378:uint = TYPE_ITERATOR++;
      
      public static const const_1395:uint = TYPE_ITERATOR++;
      
      public static const const_1001:uint = TYPE_ITERATOR++;
      
      public static const const_958:uint = TYPE_ITERATOR++;
      
      public static const const_1214:uint = TYPE_ITERATOR++;
      
      public static const const_985:uint = TYPE_ITERATOR++;
      
      public static const const_1295:uint = TYPE_ITERATOR++;
      
      public static const const_1266:uint = TYPE_ITERATOR++;
      
      public static const const_1115:uint = TYPE_ITERATOR++;
      
      public static const const_1219:uint = TYPE_ITERATOR++;
      
      public static const const_1289:uint = TYPE_ITERATOR++;
      
      public static const const_884:uint = TYPE_ITERATOR++;
      
      public static const const_1182:uint = TYPE_ITERATOR++;
      
      public static const const_1211:uint = TYPE_ITERATOR++;
      
      public static const const_1303:uint = TYPE_ITERATOR++;
      
      public static const const_1201:uint = TYPE_ITERATOR++;
      
      public static const const_252:uint = TYPE_ITERATOR++;
      
      public static const const_909:uint = TYPE_ITERATOR++;
      
      public static const const_1023:uint = TYPE_ITERATOR++;
      
      public static const const_789:uint = TYPE_ITERATOR++;
      
      public static const const_1041:uint = TYPE_ITERATOR++;
      
      public static const const_898:uint = TYPE_ITERATOR++;
      
      public static const const_1272:uint = TYPE_ITERATOR++;
      
      public static const const_1164:uint = TYPE_ITERATOR++;
      
      internal var var_1:Game;
      
      public function LinkUpdater(param1:Game)
      {
         super();
         this.var_1 = param1;
      }
      
      public static function method_2060(param1:Packet) : Boolean
      {
         return false;
      }
      
      public static function method_2130(param1:Packet) : Boolean
      {
         return false;
      }
      
      public function method_756() : void
      {
         this.var_1 = null;
      }
      
      public function method_1081(param1:Packet) : void
      {
         switch(param1.type)
         {
            case PKTTYPE_ENT_INCREMENTAL_UPDATE:
               this.method_1072(param1);
               break;
            case PKTTYPE_ENT_ADD_BUFF:
               this.method_1902(param1);
               break;
            case PKTTYPE_ENT_REMOVE_BUFF:
               this.method_1276(param1);
               break;
            case PKTTYPE_ENT_DESTROY:
               this.method_1018(param1);
               break;
            case PKTTYPE_NEWLY_RELEVANT_ENTITY:
               this.method_1615(param1);
               break;
            case PKTTYPE_PROJECTILE_EXPLODE:
               this.method_1388(param1);
               break;
            case PKTTYPE_ENT_POWER_CAST:
               this.method_1180(param1);
               break;
            case PKTTYPE_ENT_POWER_HIT:
               this.method_1957(param1);
               break;
            case PKTTYPE_WELCOME:
               this.method_1379(param1);
               break;
            case const_1298:
               this.method_495(param1);
               break;
            case PKTTYPE_FRIEND_REMOVED:
               this.method_1336(param1);
               break;
            case const_1256:
               this.method_1529(param1);
               break;
            case const_879:
               this.method_1918(param1);
               break;
            case const_901:
               this.method_1541(param1);
               break;
            case const_1260:
               this.method_1173(param1);
               break;
            case const_1008:
               this.method_1625(param1);
               break;
            case const_1112:
               this.method_1094(param1);
               break;
            case const_1229:
               this.method_1958(param1);
               break;
            case const_1165:
               this.method_1645(param1);
               break;
            case const_1241:
               this.method_1725(param1);
               break;
            case const_1157:
               this.method_1682(param1);
               break;
            case const_683:
               this.method_1454(param1);
               break;
            case const_762:
               this.method_1008(param1);
               break;
            case const_788:
               this.method_1074(param1);
               break;
            case const_805:
               this.method_1113(param1);
               break;
            case const_823:
               this.method_1757(param1);
               break;
            case const_691:
               this.method_1814(param1);
               break;
            case const_808:
               this.method_1626(param1);
               break;
            case const_716:
               this.method_1347(param1);
               break;
            case const_648:
               this.method_1653(param1);
               break;
            case const_617:
               this.method_1125(param1);
               break;
            case PKTTYPE_LOGIN_CHALLENGE:
               this.method_1607(param1);
               break;
            case PKTTYPE_LOGIN_CHARACTER_LIST:
               this.method_1772(param1);
               break;
            case const_933:
               this.method_1177(param1);
               break;
            case const_1263:
               this.method_1170(param1);
               break;
            case const_945:
               this.method_1602(param1);
               break;
            case PKTTYPE_DOOR_TARGET:
               this.method_1565(param1);
               break;
            case PKTTYPE_LOGIN_FAILURE:
               this.method_1419(param1);
               break;
            case PKTTYPE_RECEIVE_REWARD:
               this.method_1155(param1);
               break;
            case PKTTYPE_RECEIVE_LOOTDROP:
               this.method_1191(param1);
               break;
            case PKTTYPE_RECEIVE_GEAR:
               this.method_1612(param1);
               break;
            case const_1010:
               this.method_1343(param1);
               break;
            case PKTTYPE_RECEIVE_GOLD:
               this.method_1797(param1);
               break;
            case const_791:
               this.method_1159(param1);
               break;
            case const_1041:
               this.method_1974(param1);
               break;
            case const_1235:
               this.method_1676(param1);
               break;
            case const_1028:
               this.method_1000(param1);
               break;
            case const_897:
               this.method_1441(param1);
               break;
            case const_956:
               this.method_1193(param1);
               break;
            case const_1134:
               this.method_1495(param1);
               break;
            case PKTTYPE_CHAT_MESSAGE:
               this.method_1721(param1);
               break;
            case const_1061:
               this.method_1470(param1);
               break;
            case const_773:
               this.method_1146(param1);
               break;
            case const_941:
               this.method_1033(param1);
               break;
            case const_709:
               this.method_1142(param1);
               break;
            case const_252:
               this.method_1279(param1);
               break;
            case const_928:
               this.method_1217(param1);
               break;
            case PKTTYPE_CHANGE_LEVEL:
               this.method_1394(param1);
               break;
            case PKTTYPE_SERVER_ADJUST_HP:
               this.method_1549(param1);
               break;
            case PKTTYPE_BUFF_TICK_DOT:
               this.method_1473(param1);
               break;
            case const_1065:
               this.method_1295(param1);
               break;
            case PKTTYPE_CHANGE_OFFSET_Y:
               this.method_1402(param1);
               break;
            case const_760:
               this.method_1577(param1);
               break;
            case PKTTYPE_CHAR_REGEN:
               this.method_1813(param1);
               break;
            case PKTTYPE_EMOTE_BEGIN:
               this.method_1104(param1);
               break;
            case PKTTYPE_EMOTE_END:
               this.method_1224(param1);
               break;
            case PKTTYPE_RESPAWN_COMPLETE:
               this.method_1917(param1);
               break;
            case const_743:
               this.method_1335(param1);
               break;
            case const_839:
               this.method_1894(param1);
               break;
            case const_1271:
               this.method_1408(param1);
               break;
            case const_905:
               this.method_1375(param1);
               break;
            case const_1141:
               this.method_1809(param1);
               break;
            case const_894:
               this.method_1249(param1);
               break;
            case PKTTYPE_LEVEL_STATE:
               this.method_1444(param1);
               break;
            case PKTTYPE_DOOR_STATE:
               this.method_1635(param1);
               break;
            case PKTTYPE_CHAT_STATUS:
               this.method_1844(param1);
               break;
            case PKTTYPE_RECV_CHAT_PRIVATE:
               this.method_1791(param1);
               break;
            case const_1183:
               this.method_1332(param1);
               break;
            case PKTTYPE_RECV_CHAT_GUILD:
               this.method_1560(param1);
               break;
            case PKTTYPE_RECV_CHAT_OFFICER:
               this.method_1756(param1);
               break;
            case PKTTYPE_RECV_CHAT_GROUP:
               this.method_1387(param1);
               break;
            case PKTTYPE_GUILD_UPDATE:
               this.method_933(param1);
               break;
            case PKTTYPE_QUERYMESSAGE_QUESTION:
               this.method_1942(param1);
               break;
            case PKTTYPE_GROUP_UPDATE:
               this.method_1940(param1);
               break;
            case const_876:
               this.method_1036(param1);
               break;
            case PKTTYPE_ROOM_THOUGHT:
               this.method_1161(param1);
               break;
            case PKTTYPE_MISSION_PROGRESS:
               this.method_1795(param1);
               break;
            case PKTTYPE_MISSION_COMPLETE:
               this.method_1294(param1);
               break;
            case PKTTYPE_MISSION_ADDED:
               this.method_1122(param1);
               break;
            case const_990:
               this.method_1550(param1);
               break;
            case PKTTYPE_RECV_LEVEL_COMPLETE:
               this.method_1145(param1);
               break;
            case const_1126:
               this.method_1163(param1);
               break;
            case const_1031:
               this.method_1061(param1);
               break;
            case const_966:
               this.ReceiveAbilityResearchDone(param1);
               break;
            case const_1137:
               this.method_1914(param1);
               break;
            case const_694:
               this.method_1545(param1);
               break;
            case const_767:
               this.method_1172(param1);
               break;
            case const_1178:
               this.method_1827(param1);
               break;
            case const_838:
               this.method_1204(param1);
               break;
            case const_1153:
               this.method_1655(param1);
               break;
            case const_920:
               this.method_1099(param1);
               break;
            case const_1158:
               this.method_1024(param1);
               break;
            case const_1027:
               this.method_1499(param1);
               break;
            case const_981:
               this.method_1699(param1);
               break;
            case const_939:
               this.method_1555(param1);
               break;
            case const_962:
               this.method_1893(param1);
               break;
            case const_1104:
               this.method_1816(param1);
               break;
            case const_1280:
               this.method_1711(param1);
               break;
            case const_1142:
               this.method_1175(param1);
               break;
            case const_1037:
               this.method_1789(param1);
               break;
            case const_975:
               this.method_1044(param1);
               break;
            case const_1255:
               this.method_1834(param1);
               break;
            case const_1001:
               this.method_1620(param1);
               break;
            case const_1214:
               this.method_1898(param1);
               break;
            case const_985:
               this.method_1654(param1);
               break;
            case const_1295:
               this.method_1950(param1);
               break;
            case const_1266:
               this.method_1846(param1);
               break;
            case const_884:
               this.method_1622(param1);
               break;
            case const_1182:
               this.method_1961(param1);
               break;
            case const_1211:
               this.method_1831(param1);
               break;
            case const_1303:
               this.method_1779(param1);
               break;
            case const_1201:
               this.method_1091(param1);
               break;
            case const_1023:
               this.method_1015(param1);
               break;
            case const_898:
               this.method_1694(param1);
         }
      }
      
      public function method_1750() : void
      {
         var _loc2_:Packet = null;
         if(!this.var_1.serverConn)
         {
            return;
         }
         if(!this.var_1.serverConn.method_353())
         {
            return;
         }
         var _loc1_:Vector.<Packet> = this.var_1.serverConn.method_918();
         for each(_loc2_ in _loc1_)
         {
            this.method_1081(_loc2_);
         }
      }
      
      private function method_1388(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:int = param1.method_45();
         var _loc5_:int = param1.method_45();
         var _loc6_:Boolean = param1.method_11();
         var _loc7_:class_130 = this.var_1.method_2004(_loc2_,_loc3_);
         if(_loc7_)
         {
            _loc7_.method_106(_loc4_,_loc5_,null,_loc6_);
         }
      }
      
      public function WriteProjectileExplode(param1:Entity, param2:int, param3:Number, param4:Number, param5:Boolean) : void
      {
         var _loc6_:Packet = new Packet(LinkUpdater.PKTTYPE_PROJECTILE_EXPLODE);
         _loc6_.method_9(param1.id);
         _loc6_.method_9(param2);
         _loc6_.method_24(param3);
         _loc6_.method_24(param4);
         _loc6_.method_15(param5);
         this.var_1.serverConn.SendPacket(_loc6_);
      }
      
      private function method_495(param1:Packet, param2:Friend = null) : void
      {
         var _loc8_:Friend = null;
         var _loc9_:String = null;
         var _loc10_:String = null;
         var _loc3_:Boolean = false;
         var _loc4_:* = param2 == null;
         var _loc5_:String = param1.method_13();
         if(!param2)
         {
            for each(_loc8_ in this.var_1.friendList)
            {
               if(_loc8_.var_207 == _loc5_)
               {
                  param2 = _loc8_;
                  break;
               }
            }
         }
         if(!param2)
         {
            _loc3_ = true;
            param2 = new Friend();
            this.var_1.friendList.push(param2);
         }
         var _loc6_:Boolean = param2.bOnline;
         var _loc7_:Boolean = param2.var_276;
         param2.var_207 = _loc5_;
         param2.var_276 = param1.method_11();
         param2.bOnline = param1.method_11();
         if(param2.bOnline)
         {
            param2.charName = param1.method_11() ? param1.method_13() : _loc5_;
            param2.className = Entity.method_244(param1.method_6(Entity.const_244));
            param2.var_2100 = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         }
         if(_loc4_)
         {
            _loc9_ = param2.charName ? param2.charName : _loc5_;
            _loc10_ = this.var_1.FormatHotName(_loc9_);
            if(_loc3_ && param2.var_276)
            {
               this.var_1.screenNotification.ShowNotification(class_46.const_381,_loc9_ + " wants to be your friend","M",false);
            }
            else if(_loc3_ && !param2.var_276)
            {
               this.var_1.screenNotification.ShowNotification(class_46.const_381,_loc9_ + " has accepted your friend request","M",false);
            }
            else if(_loc6_ && !param2.bOnline && !param2.var_276)
            {
               this.var_1.screenNotification.ShowNotification(class_46.const_647,_loc9_ + " has logged off","M",false);
            }
            else if(!_loc6_ && param2.bOnline && !param2.var_276)
            {
               this.var_1.screenNotification.ShowNotification(class_46.const_720,_loc9_ + " has logged on","M",false);
            }
            else if(_loc7_ && !param2.var_276)
            {
               this.var_1.screenNotification.ShowNotification(class_46.const_381,"You are now friends with " + _loc9_,"M",false);
            }
            this.var_1.method_365(this.var_1.friendList);
         }
      }
      
      private function method_1336(param1:Packet) : void
      {
         var _loc3_:uint = 0;
         var _loc5_:Friend = null;
         var _loc2_:String = param1.method_13();
         var _loc4_:uint = this.var_1.friendList.length;
         _loc3_ = 0;
         while(_loc3_ < _loc4_)
         {
            _loc5_ = this.var_1.friendList[_loc3_];
            if(_loc2_ == _loc5_.var_207)
            {
               this.var_1.friendList.splice(_loc3_,1);
               break;
            }
            _loc3_++;
         }
         this.var_1.method_365(this.var_1.friendList);
      }
      
      private function method_1529(param1:Packet) : void
      {
         var _loc3_:String = null;
         var _loc4_:String = null;
         var _loc5_:uint = 0;
         var _loc2_:Vector.<Friend> = new Vector.<Friend>();
         while(param1.method_11())
         {
            _loc3_ = param1.method_13();
            _loc4_ = Entity.method_244(param1.method_6(Entity.const_244));
            _loc5_ = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
            _loc2_.push(new Friend(_loc3_,null,true,_loc5_,_loc4_));
         }
         this.var_1.var_1004 = _loc2_;
         this.var_1.screenFriend.method_392(this.var_1.var_1004,false);
      }
      
      private function method_1827(param1:Packet) : void
      {
         var _loc5_:Friend = null;
         var _loc2_:Vector.<Friend> = new Vector.<Friend>();
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = 0;
         while(_loc4_ < _loc3_)
         {
            _loc5_ = new Friend();
            this.method_495(param1,_loc5_);
            _loc2_.push(_loc5_);
            _loc4_++;
         }
         this.var_1.method_365(_loc2_);
      }
      
      private function method_1918(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = Entity.method_244(param1.method_6(Entity.const_244));
         var _loc4_:uint = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         var _loc5_:uint = param1.method_6(Entity.const_172);
         this.var_1.var_124.push(new Friend(_loc2_,null,true,_loc4_,_loc3_,false,_loc5_));
         var _loc6_:String = this.var_1.FormatHotName(_loc2_);
         this.var_1.screenChat.method_84("Your guildmate " + _loc6_ + " has logged on.");
         this.var_1.screenFriend.method_159(this.var_1.var_124);
      }
      
      private function method_1541(param1:Packet) : void
      {
         var _loc3_:uint = 0;
         var _loc6_:Friend = null;
         var _loc2_:String = param1.method_13();
         var _loc4_:uint = this.var_1.var_124.length;
         _loc3_ = 0;
         while(_loc3_ < _loc4_)
         {
            _loc6_ = this.var_1.var_124[_loc3_];
            if(_loc6_.charName == _loc2_)
            {
               this.var_1.var_124.splice(_loc3_,1);
               break;
            }
            _loc3_++;
         }
         var _loc5_:String = this.var_1.FormatHotName(_loc2_);
         this.var_1.screenChat.method_84("Your guildmate " + _loc5_ + " has logged off.");
         this.var_1.screenFriend.method_159(this.var_1.var_124);
      }
      
      private function method_1173(param1:Packet) : void
      {
         var _loc7_:uint = 0;
         var _loc12_:Friend = null;
         var _loc2_:Friend = null;
         var _loc3_:String = param1.method_13();
         var _loc4_:String = param1.method_13();
         var _loc5_:uint = param1.method_6(Entity.const_172);
         var _loc6_:uint = param1.method_6(Entity.const_172);
         var _loc8_:uint = this.var_1.var_124.length;
         _loc7_ = 0;
         while(_loc7_ < _loc8_)
         {
            _loc12_ = this.var_1.var_124[_loc7_];
            if(_loc12_.charName == _loc4_)
            {
               _loc2_ = _loc12_;
               break;
            }
            _loc7_++;
         }
         var _loc9_:String = this.var_1.FormatHotName(_loc3_);
         var _loc10_:String = this.var_1.FormatHotName(_loc4_);
         if(_loc6_ == Entity.const_236)
         {
            this.var_1.screenChat.method_84(_loc9_ + " has promoted " + _loc10_ + " to be the new guild leader!");
         }
         else if(_loc3_ == _loc4_)
         {
            this.var_1.screenChat.method_84(_loc9_ + " has stepped down!");
         }
         else if(_loc6_ < _loc5_)
         {
            this.var_1.screenChat.method_84(_loc9_ + " has promoted " + _loc10_ + " to the Rank: " + Entity.method_850(_loc6_) + "!");
         }
         else
         {
            this.var_1.screenChat.method_84(_loc9_ + " has demoted " + _loc10_ + " to the Rank: " + Entity.method_850(_loc6_) + "!");
         }
         var _loc11_:Entity = this.var_1.clientEnt;
         if(Boolean(_loc11_) && this.var_1.clientEntName == _loc4_)
         {
            _loc11_.var_2039 = _loc6_;
         }
         if(_loc2_)
         {
            _loc2_.var_289 = _loc6_;
            this.var_1.screenFriend.method_159(this.var_1.var_124);
         }
      }
      
      private function method_1625(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = Entity.method_244(param1.method_6(Entity.const_244));
         var _loc4_:uint = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         var _loc5_:uint = param1.method_6(Entity.const_172);
         this.var_1.var_124.push(new Friend(_loc2_,null,true,_loc4_,_loc3_,false,_loc5_));
         var _loc6_:String = this.var_1.FormatHotName(_loc2_);
         this.var_1.screenChat.method_84(_loc6_ + " has joined your guild!");
         this.var_1.screenFriend.method_159(this.var_1.var_124);
      }
      
      private function method_1094(param1:Packet) : void
      {
         var _loc4_:uint = 0;
         var _loc8_:Friend = null;
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         var _loc5_:uint = this.var_1.var_124.length;
         _loc4_ = 0;
         while(_loc4_ < _loc5_)
         {
            _loc8_ = this.var_1.var_124[_loc4_];
            if(_loc8_.charName == _loc3_)
            {
               this.var_1.var_124.splice(_loc4_,1);
               break;
            }
            _loc4_++;
         }
         var _loc6_:String = this.var_1.FormatHotName(_loc3_);
         var _loc7_:String = this.var_1.FormatHotName(_loc2_);
         if(_loc3_ != _loc2_)
         {
            this.var_1.screenChat.method_84(_loc7_ + " has kicked " + _loc6_ + " from the guild!");
         }
         else
         {
            this.var_1.screenChat.method_84(_loc6_ + " has left the guild!");
         }
         this.var_1.screenFriend.method_159(this.var_1.var_124);
      }
      
      private function method_1958(param1:Packet) : void
      {
         var _loc3_:uint = 0;
         var _loc6_:Friend = null;
         var _loc2_:String = param1.method_13();
         var _loc4_:uint = this.var_1.var_340.length;
         _loc3_ = 0;
         while(_loc3_ < _loc4_)
         {
            _loc6_ = this.var_1.var_340[_loc3_];
            if(_loc6_.charName == _loc2_)
            {
               this.var_1.var_340.splice(_loc3_,1);
               break;
            }
            _loc3_++;
         }
         var _loc5_:String = this.var_1.FormatHotName(_loc2_);
         this.var_1.screenChat.method_84("You are no longer ignoring " + _loc5_ + ".");
         this.var_1.screenFriend.method_246(this.var_1.var_340);
      }
      
      private function method_1645(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         this.var_1.var_340.push(new Friend(_loc2_));
         var _loc3_:String = this.var_1.FormatHotName(_loc2_);
         this.var_1.screenChat.method_84("You are now ignoring " + _loc3_ + ".");
         this.var_1.screenFriend.method_246(this.var_1.var_340);
      }
      
      private function method_1725(param1:Packet) : void
      {
         var _loc5_:String = null;
         var _loc2_:Vector.<Friend> = new Vector.<Friend>();
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = 0;
         while(_loc4_ < _loc3_)
         {
            _loc5_ = param1.method_13();
            _loc2_.push(new Friend(_loc5_));
            _loc4_++;
         }
         this.var_1.var_340 = _loc2_;
         this.var_1.screenFriend.method_246(this.var_1.var_340);
      }
      
      private function method_1682(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:Boolean = param1.method_11();
         this.var_1.mMammothIdols = _loc2_;
         this.var_1.mbShowHigher = _loc4_;
         if(_loc3_)
         {
            class_53.method_721("Payment",_loc3_,"USD");
         }
      }
      
      public function method_1483(param1:uint, param2:String, param3:String, param4:Boolean) : void
      {
         var _loc5_:Packet = new Packet(LinkUpdater.const_808);
         _loc5_.method_9(param1);
         _loc5_.method_26(param2);
         _loc5_.method_26(param3);
         _loc5_.method_15(param4);
         this.var_1.serverConn.SendPacket(_loc5_);
      }
      
      public function WriteEntityUntargetable(param1:uint, param2:Boolean) : void
      {
         var _loc3_:Packet = new Packet(LinkUpdater.const_691);
         _loc3_.method_9(param1);
         _loc3_.method_15(param2);
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1814(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Boolean = param1.method_11();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.bUntargetable = _loc3_;
         }
      }
      
      private function method_1626(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:String = param1.method_13();
         var _loc5_:Boolean = param1.method_11();
         var _loc6_:Room = this.var_1.method_111(_loc2_);
         if(_loc6_)
         {
            _loc6_.method_526(_loc3_,_loc4_,_loc5_);
         }
      }
      
      public function method_1227(param1:uint, param2:uint) : void
      {
         var _loc3_:Packet = new Packet(const_648);
         _loc3_.method_9(param1);
         _loc3_.method_9(param2);
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1653(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:Room = this.var_1.method_111(_loc2_);
         if(_loc4_)
         {
            _loc4_.var_1207 = _loc3_;
         }
      }
      
      public function method_1369(param1:uint, param2:uint, param3:String, param4:uint, param5:String) : void
      {
         var _loc6_:Packet = new Packet(const_788);
         _loc6_.method_9(param1);
         _loc6_.method_9(param2);
         _loc6_.method_26(param3);
         _loc6_.method_9(param4);
         _loc6_.method_26(param5);
         this.var_1.serverConn.SendPacket(_loc6_);
      }
      
      public function method_1074(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:String = param1.method_13();
         var _loc5_:uint = param1.method_4();
         var _loc6_:String = param1.method_13();
         var _loc7_:Room = this.var_1.method_111(_loc2_);
         if(_loc7_)
         {
            _loc7_.method_903(_loc3_,_loc4_,_loc5_,_loc6_);
         }
      }
      
      public function method_1286(param1:uint, param2:uint, param3:String, param4:uint, param5:String) : void
      {
         var _loc6_:Packet = new Packet(const_805);
         _loc6_.method_9(param1);
         _loc6_.method_9(param2);
         _loc6_.method_26(param3);
         _loc6_.method_9(param4);
         _loc6_.method_26(param5);
         this.var_1.serverConn.SendPacket(_loc6_);
      }
      
      public function method_1113(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:String = param1.method_13();
         var _loc5_:uint = param1.method_4();
         var _loc6_:String = param1.method_13();
         var _loc7_:Room = this.var_1.method_111(_loc2_);
         if(_loc7_)
         {
            _loc7_.method_935(_loc3_,_loc4_,_loc5_,_loc6_);
         }
      }
      
      public function method_1986(param1:uint) : void
      {
         var _loc2_:Packet = new Packet(const_823);
         _loc2_.method_9(param1);
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      public function method_1757(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Room = this.var_1.method_111(_loc2_);
         if(_loc3_)
         {
            _loc3_.method_876();
         }
      }
      
      public function method_1765(param1:uint, param2:uint) : void
      {
         var _loc3_:Packet = new Packet(const_617);
         _loc3_.method_9(param1);
         _loc3_.method_9(param2);
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1125(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:Room = this.var_1.method_111(_loc2_);
         if(_loc4_)
         {
            _loc4_.method_237(_loc3_);
         }
      }
      
      public function method_1065(param1:uint, param2:String, param3:Number) : void
      {
         var _loc4_:Packet = new Packet(const_716);
         _loc4_.method_9(param1);
         _loc4_.method_26(param2);
         _loc4_.method_9(uint(param3 * 100));
         this.var_1.serverConn.SendPacket(_loc4_);
      }
      
      private function method_1347(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:Number = param1.method_4() / 100;
         var _loc5_:Room = this.var_1.method_111(_loc2_);
         if(_loc5_)
         {
            _loc5_.method_562(_loc3_,_loc4_);
         }
      }
      
      private function method_1454(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Room = this.var_1.method_111(_loc2_);
         var _loc4_:Boolean = param1.method_11();
         if(_loc3_)
         {
            _loc3_.method_572(_loc4_);
         }
      }
      
      private function method_1008(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Room = this.var_1.method_111(_loc2_);
         if(_loc3_)
         {
            _loc3_.method_752();
         }
      }
      
      private function method_1974(param1:Packet) : void
      {
         var _loc4_:Entity = null;
         var _loc5_:* = false;
         var _loc6_:EntType = null;
         var _loc7_:uint = 0;
         var _loc8_:uint = 0;
         var _loc9_:uint = 0;
         var _loc10_:EntTypeGear = null;
         var _loc11_:GearType = null;
         var _loc12_:uint = 0;
         var _loc13_:class_42 = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc3_)
         {
            _loc4_ = this.var_1.clientEnt;
            _loc5_ = _loc3_ == _loc4_;
            _loc6_ = _loc3_.entType;
            _loc7_ = 1;
            while(_loc7_ < EntType.MAX_SLOTS)
            {
               if(param1.method_11())
               {
                  _loc8_ = param1.method_6(class_21.const_50);
                  _loc9_ = param1.method_6(class_21.const_50);
                  _loc10_ = _loc6_.equippedGear[_loc7_];
                  _loc11_ = _loc10_ ? class_14.gearTypesDict[_loc10_.gearName] : null;
                  if(Boolean(_loc11_) && _loc11_.var_884)
                  {
                     _loc11_ = null;
                     _loc10_ = null;
                  }
                  if(_loc10_)
                  {
                     if(_loc8_)
                     {
                        _loc10_.var_644 = _loc8_;
                     }
                     if(_loc9_)
                     {
                        _loc10_.var_705 = _loc9_;
                     }
                     _loc10_.method_875();
                  }
                  if(_loc5_)
                  {
                     _loc12_ = _loc11_ ? _loc11_.gearID : 0;
                     if(!_loc12_)
                     {
                        _loc12_ = _loc4_.mEquipGear[_loc7_];
                     }
                     _loc13_ = _loc12_ ? this.var_1.mOwnedGear[_loc12_] : null;
                     if(_loc13_)
                     {
                        if(_loc8_)
                        {
                           _loc13_.var_295 = class_14.var_194[_loc8_];
                        }
                        if(_loc9_)
                        {
                           _loc13_.var_307 = class_14.var_194[_loc9_];
                        }
                     }
                  }
               }
               _loc7_++;
            }
            if(param1.method_11())
            {
               _loc6_.shirtColor = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
            }
            if(param1.method_11())
            {
               _loc6_.pantColor = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
            }
            _loc6_.gfxType = _loc6_.method_60();
            _loc3_.ResetEntType(_loc6_);
            if(_loc5_)
            {
               this.var_1.screenDyeGear.method_1588();
            }
         }
      }
      
      private function method_1159(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         this.var_1.level.method_528(_loc2_);
      }
      
      private function method_1379(param1:Packet) : void
      {
         var _loc17_:Array = null;
         var _loc18_:String = null;
         var _loc19_:uint = 0;
         var _loc20_:uint = 0;
         var _loc21_:uint = 0;
         var _loc22_:uint = 0;
         var _loc23_:uint = 0;
         var _loc24_:uint = 0;
         var _loc25_:uint = 0;
         var _loc26_:uint = 0;
         var _loc27_:uint = 0;
         var _loc28_:uint = 0;
         var _loc29_:uint = 0;
         var _loc46_:Point = null;
         var _loc47_:uint = 0;
         var _loc48_:uint = 0;
         var _loc49_:uint = 0;
         var _loc50_:uint = 0;
         var _loc51_:uint = 0;
         var _loc52_:uint = 0;
         var _loc53_:uint = 0;
         var _loc54_:Vector.<Friend> = null;
         var _loc55_:uint = 0;
         var _loc56_:uint = 0;
         var _loc57_:class_45 = null;
         var _loc58_:int = 0;
         var _loc59_:int = 0;
         var _loc60_:int = 0;
         var _loc61_:int = 0;
         var _loc62_:String = null;
         var _loc63_:String = null;
         var _loc64_:String = null;
         var _loc65_:String = null;
         var _loc66_:uint = 0;
         var _loc67_:uint = 0;
         var _loc68_:uint = 0;
         var _loc69_:String = null;
         var _loc70_:GearType = null;
         var _loc71_:uint = 0;
         var _loc72_:uint = 0;
         var _loc73_:uint = 0;
         var _loc74_:uint = 0;
         var _loc75_:uint = 0;
         var _loc76_:Vector.<uint> = null;
         var _loc77_:String = null;
         var _loc78_:uint = 0;
         var _loc79_:uint = 0;
         var _loc80_:class_20 = null;
         var _loc81_:uint = 0;
         var _loc82_:uint = 0;
         var _loc83_:uint = 0;
         var _loc84_:uint = 0;
         var _loc85_:class_7 = null;
         var _loc86_:class_87 = null;
         var _loc87_:uint = 0;
         var _loc88_:uint = 0;
         var _loc89_:class_64 = null;
         var _loc90_:uint = 0;
         var _loc91_:uint = 0;
         var _loc92_:class_8 = null;
         var _loc93_:uint = 0;
         var _loc94_:uint = 0;
         var _loc95_:class_15 = null;
         var _loc96_:class_151 = null;
         var _loc97_:uint = 0;
         var _loc98_:uint = 0;
         var _loc99_:class_3 = null;
         var _loc100_:class_103 = null;
         var _loc101_:class_13 = null;
         var _loc102_:uint = 0;
         var _loc103_:Mission = null;
         var _loc104_:uint = 0;
         var _loc105_:Friend = null;
         var _loc106_:int = 0;
         var _loc107_:uint = 0;
         var _loc108_:uint = 0;
         var _loc109_:Vector.<uint> = null;
         var _loc110_:uint = 0;
         var _loc111_:uint = 0;
         var _loc112_:uint = 0;
         var _loc113_:uint = 0;
         var _loc114_:class_87 = null;
         var _loc115_:uint = 0;
         var _loc116_:uint = 0;
         var _loc117_:uint = 0;
         var _loc118_:uint = 0;
         var _loc119_:uint = 0;
         var _loc120_:uint = 0;
         var _loc121_:uint = 0;
         var _loc122_:uint = 0;
         var _loc123_:uint = 0;
         var _loc124_:uint = 0;
         var _loc125_:uint = 0;
         var _loc126_:uint = 0;
         var _loc127_:class_10 = null;
         var _loc128_:class_10 = null;
         var _loc129_:uint = 0;
         var _loc130_:uint = 0;
         var _loc131_:uint = 0;
         var _loc132_:uint = 0;
         var _loc133_:uint = 0;
         var _loc134_:uint = 0;
         var _loc135_:uint = 0;
         var _loc136_:uint = 0;
         var _loc137_:uint = 0;
         var _loc138_:uint = 0;
         var _loc139_:class_87 = null;
         var _loc140_:class_22 = null;
         var _loc141_:uint = 0;
         var _loc142_:uint = 0;
         var _loc143_:uint = 0;
         var _loc144_:uint = 0;
         var _loc145_:String = null;
         var _loc146_:String = null;
         var _loc147_:uint = 0;
         var _loc148_:String = null;
         var _loc149_:String = null;
         var _loc150_:Room = null;
         var _loc157_:PowerType = null;
         var _loc158_:BuffType = null;
         var _loc159_:PowerType = null;
         var _loc160_:BuffType = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = param1.method_6(Game.const_813);
         var _loc5_:uint = param1.method_4();
         var _loc6_:String = param1.method_13();
         var _loc7_:String = this.method_870(_loc6_,param1);
         var _loc8_:uint = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         var _loc9_:uint = param1.method_4();
         var _loc10_:uint = param1.method_4();
         var _loc11_:uint = param1.method_4();
         var _loc12_:uint = param1.method_4();
         var _loc13_:uint = param1.method_4();
         var _loc14_:Boolean = param1.method_11();
         var _loc15_:uint = param1.method_11() ? param1.method_4() : 0;
         var _loc16_:class_118 = new class_118(this.var_1);
         this.var_1.method_1633(_loc3_);
         if(param1.method_11())
         {
            _loc46_ = new Point();
            _loc46_.x = param1.method_45();
            _loc46_.y = param1.method_45();
            this.var_1.targetDoor = 0;
            this.var_1.var_1025 = _loc46_;
         }
         var _loc30_:Boolean = param1.method_11();
         if(_loc30_)
         {
            _loc47_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
            _loc48_ = 0;
            while(_loc48_ < _loc47_)
            {
               _loc67_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc68_ = param1.method_6(GearType.const_176);
               _loc69_ = Game.method_110(_loc67_,_loc68_);
               _loc70_ = class_14.var_421[_loc69_];
               if(!param1.method_11())
               {
                  if(_loc70_)
                  {
                     this.var_1.method_532(_loc70_.gearID,_loc68_,0,0,0,false,0,0);
                  }
               }
               else
               {
                  _loc71_ = param1.method_11() ? param1.method_6(class_64.const_101) : 0;
                  _loc72_ = param1.method_11() ? param1.method_6(class_64.const_101) : 0;
                  _loc73_ = param1.method_11() ? param1.method_6(class_64.const_101) : 0;
                  _loc74_ = param1.method_11() ? param1.method_6(class_21.const_50) : 0;
                  _loc75_ = param1.method_11() ? param1.method_6(class_21.const_50) : 0;
                  if(_loc70_)
                  {
                     this.var_1.method_532(_loc70_.gearID,_loc68_,_loc71_,_loc72_,_loc73_,false,_loc74_,_loc75_);
                  }
               }
               _loc48_++;
            }
            _loc49_ = param1.method_6(GearType.const_348);
            _loc48_ = 0;
            while(_loc48_ < _loc49_)
            {
               _loc76_ = new Vector.<uint>(EntType.MAX_SLOTS);
               _loc77_ = param1.method_13();
               _loc76_[EntType.ARMOR_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc76_[EntType.GLOVES_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc76_[EntType.BOOTS_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc76_[EntType.HAT_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc76_[EntType.SWORD_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               _loc76_[EntType.SHIELD_SLOT] = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
               this.var_1.mGearsetList.push(_loc76_);
               this.var_1.mGearsetListName.push(_loc77_);
               _loc48_++;
            }
            this.var_1.var_2558 = param1.method_11();
            if(this.var_1.var_2558)
            {
               _loc48_ = 0;
               while(_loc48_ < Game.const_79)
               {
                  if(param1.method_11())
                  {
                     _loc78_ = param1.method_393();
                     this.var_1.mKeybindManager.method_32(_loc48_ + 1,_loc78_);
                  }
                  _loc48_++;
               }
            }
            _loc50_ = param1.method_4();
            _loc48_ = 0;
            while(_loc48_ < _loc50_)
            {
               _loc79_ = param1.method_4();
               _loc80_ = class_14.var_464[_loc79_];
               if(_loc80_)
               {
                  this.var_1.mOwnedMounts[_loc80_.var_197] = _loc80_;
               }
               _loc48_++;
            }
            _loc51_ = param1.method_4();
            _loc48_ = 0;
            while(_loc48_ < _loc51_)
            {
               _loc81_ = param1.method_6(class_7.const_19);
               _loc82_ = param1.method_6(class_7.const_75);
               _loc83_ = param1.method_4();
               _loc84_ = param1.method_4();
               _loc85_ = class_14.var_224[_loc81_];
               if(_loc85_)
               {
                  _loc86_ = new class_87(this.var_1,_loc85_,_loc82_,_loc83_,_loc84_);
                  this.var_1.mEggPetInfo.method_713(_loc86_);
               }
               _loc48_++;
            }
            while(param1.method_11())
            {
               _loc87_ = param1.method_6(class_64.const_101);
               _loc88_ = param1.method_11() ? param1.method_4() : 1;
               if(_loc87_)
               {
                  _loc89_ = class_64.method_56(_loc87_);
                  if(_loc89_)
                  {
                     if(_loc89_.method_1708())
                     {
                        this.var_1.mRespecStoneCount = _loc88_;
                     }
                     else
                     {
                        this.var_1.mOwnedCharms[_loc87_] = new class_114(_loc88_,_loc89_);
                     }
                  }
               }
            }
            while(param1.method_11())
            {
               _loc90_ = param1.method_4();
               _loc91_ = param1.method_11() ? param1.method_4() : 1;
               _loc92_ = class_14.var_629[_loc90_];
               if(_loc92_)
               {
                  this.var_1.mOwnedMaterials[_loc90_] = new class_76(_loc91_,_loc92_);
               }
            }
            while(param1.method_11())
            {
               _loc93_ = param1.method_4();
               _loc94_ = param1.method_4();
               _loc95_ = class_14.var_838[_loc93_];
               if(_loc95_)
               {
                  _loc96_ = new class_151(_loc95_,_loc94_);
                  this.var_1.mLockboxData.mOwnedLockboxes[_loc93_] = _loc96_;
                  this.var_1.mLockboxData.mLockboxList.push(_loc96_);
                  ++this.var_1.mLockboxData.mUniqueLockboxes;
               }
            }
            this.var_1.mLockboxData.mLockboxKeys = param1.method_4();
            this.var_1.mLockboxData.mRoyalSigils = param1.method_4();
            this.var_1.mAlertState = param1.method_6(Game.const_646);
            _loc48_ = 1;
            while(_loc48_ <= class_21.const_763)
            {
               if(!param1.method_11())
               {
                  this.var_1.mOwnedDyes[_loc48_] = false;
               }
               else
               {
                  this.var_1.mOwnedDyes[_loc48_] = true;
                  ++this.var_1.var_1407;
               }
               _loc48_++;
            }
            while(param1.method_11())
            {
               _loc97_ = param1.method_4();
               _loc98_ = param1.method_4();
               _loc99_ = class_14.var_419[_loc97_];
               _loc100_ = new class_103(_loc99_,_loc98_);
               this.var_1.mOwnedConsumables[_loc97_] = _loc100_;
               this.var_1.mConsumablesList.push(_loc100_);
            }
            _loc17_ = new Array();
            _loc52_ = param1.method_4();
            _loc53_ = 1;
            while(_loc53_ <= _loc52_)
            {
               _loc101_ = class_14.var_238[_loc53_];
               if(_loc101_.var_1775)
               {
                  if(param1.method_11())
                  {
                     _loc17_[_loc53_] = new Mission(_loc53_,Mission.const_72,0);
                  }
               }
               else if(param1.method_11())
               {
                  if(!param1.method_11())
                  {
                     _loc104_ = _loc101_.var_908 > 1 ? param1.method_4() : 0;
                     _loc17_[_loc53_] = new Mission(_loc53_,Mission.const_213,_loc104_);
                  }
                  else
                  {
                     _loc102_ = param1.method_11() ? Mission.const_72 : Mission.const_58;
                     _loc103_ = new Mission(_loc53_,_loc102_,0);
                     if(_loc101_.var_134)
                     {
                        _loc103_.var_588 = param1.method_6(class_119.const_228);
                        _loc103_.var_1745 = param1.method_4();
                        _loc103_.var_2806 = param1.method_4();
                     }
                     _loc17_[_loc53_] = _loc103_;
                  }
               }
               _loc53_++;
            }
            _loc54_ = new Vector.<Friend>();
            _loc55_ = param1.method_4();
            _loc48_ = 0;
            while(_loc48_ < _loc55_)
            {
               _loc105_ = new Friend();
               this.method_495(param1,_loc105_);
               _loc54_.push(_loc105_);
               _loc48_++;
            }
            _loc56_ = 0;
            _loc57_ = this.var_1.mAbilityBook;
            _loc58_ = int(param1.method_6(class_10.const_83));
            _loc48_ = 0;
            while(_loc48_ < _loc58_)
            {
               _loc106_ = int(param1.method_6(class_10.const_83));
               _loc107_ = param1.method_6(class_10.const_665);
               if(_loc57_)
               {
                  _loc57_.method_1859(_loc106_,_loc107_);
               }
               _loc48_++;
            }
            _loc59_ = int(param1.method_6(class_10.const_83));
            _loc60_ = int(param1.method_6(class_10.const_83));
            _loc61_ = int(param1.method_6(class_10.const_83));
            if(_loc57_)
            {
               if(_loc59_ != 0)
               {
                  _loc57_.SetAbilities(1,class_14.var_478[_loc59_]);
               }
               if(_loc60_ != 0)
               {
                  _loc57_.SetAbilities(2,class_14.var_478[_loc60_]);
               }
               if(_loc61_ != 0)
               {
                  _loc57_.SetAbilities(3,class_14.var_478[_loc61_]);
               }
            }
            _loc26_ = param1.method_4();
            if(this.var_1.mCraftTalentData)
            {
               this.var_1.mCraftTalentData.method_1965(_loc26_,_loc11_);
            }
            _loc27_ = param1.method_6(class_66.const_409);
            _loc28_ = param1.method_6(class_66.const_409);
            _loc29_ = param1.method_6(class_66.const_409);
            if(this.var_1.mMasterClassTower)
            {
               this.var_1.mMasterClassTower.method_995(_loc27_,_loc28_,_loc29_);
            }
            if(param1.method_11())
            {
               _loc19_ = param1.method_6(class_9.const_28);
               _loc20_ = param1.method_6(class_9.const_28);
               _loc21_ = param1.method_6(class_9.const_28);
               _loc22_ = param1.method_6(class_9.const_28);
               _loc23_ = param1.method_6(class_9.const_28);
               _loc24_ = param1.method_6(class_9.const_28);
               _loc25_ = param1.method_6(class_9.const_28);
               if(!param1.method_11())
               {
                  this.var_1.mMagicForgeStatus.status = class_111.const_509;
               }
               else
               {
                  _loc115_ = 0;
                  _loc116_ = 0;
                  _loc117_ = 0;
                  _loc118_ = param1.method_6(class_1.const_254);
                  _loc119_ = 0;
                  _loc120_ = class_111.const_509;
                  if(param1.method_11())
                  {
                     _loc120_ = class_111.const_286;
                     _loc117_ = param1.method_4();
                  }
                  else
                  {
                     _loc120_ = class_111.const_264;
                     _loc115_ = param1.method_6(class_64.const_499);
                     if(_loc115_)
                     {
                        _loc116_ = param1.method_6(class_64.const_218);
                        _loc119_ = param1.method_6(class_111.const_432);
                     }
                  }
                  _loc121_ = param1.method_91();
                  _loc122_ = param1.method_91();
                  this.var_1.mMagicForgeStatus.primary = _loc118_;
                  this.var_1.mMagicForgeStatus.status = _loc120_;
                  this.var_1.mMagicForgeStatus.var_8 = _loc115_;
                  this.var_1.mMagicForgeStatus.secondary = _loc116_;
                  this.var_1.mMagicForgeStatus.endtime = _loc117_;
                  this.var_1.mMagicForgeStatus.var_2675 = _loc121_;
                  this.var_1.mMagicForgeStatus.var_2316 = _loc122_;
                  this.var_1.mMagicForgeStatus.usedlist = _loc119_;
               }
               this.var_1.mMagicForgeStatus.var_2434 = param1.method_11();
               if(param1.method_11())
               {
                  _loc123_ = param1.method_6(class_10.const_83);
                  _loc124_ = param1.method_4();
                  _loc125_ = this.var_1.mAbilityBook.GetCurrRankByAbilityID(_loc123_);
                  _loc126_ = _loc125_ + 1;
                  _loc127_ = class_14.var_478[_loc123_];
                  if(_loc127_ && _loc127_.var_90 >= 4 && _loc126_ == 1)
                  {
                     _loc126_ = 2;
                  }
                  _loc128_ = class_10.method_591(_loc123_,_loc126_);
                  if(_loc128_)
                  {
                     this.var_1.mAbilityBook.mAbilityResearch = _loc128_;
                     this.var_1.mAbilityBook.mAbilityResearchFinishTime = _loc124_;
                     this.var_1.mAbilityBook.mStatus = _loc124_ ? class_45.const_191 : class_45.const_223;
                  }
               }
               if(param1.method_11())
               {
                  _loc129_ = param1.method_6(class_9.const_129);
                  _loc130_ = param1.method_4();
                  if(this.var_1.mBuildingInfo)
                  {
                     this.var_1.mBuildingInfo.method_1277(_loc129_,_loc130_);
                  }
               }
               if(param1.method_11())
               {
                  _loc131_ = param1.method_6(class_66.const_571);
                  _loc132_ = param1.method_4();
                  if(this.var_1.mMasterClassTower)
                  {
                     this.var_1.mMasterClassTower.SetCurrentResearch(_loc131_,_loc132_);
                  }
               }
               if(param1.method_11())
               {
                  _loc133_ = param1.method_6(class_16.const_167);
                  _loc134_ = param1.method_4();
                  this.var_1.mEggPetInfo.SetEggData(_loc133_,_loc134_);
               }
               _loc108_ = param1.method_6(class_16.const_167);
               _loc109_ = new Vector.<uint>();
               _loc110_ = 0;
               while(_loc110_ < _loc108_)
               {
                  _loc135_ = param1.method_6(class_16.const_167);
                  _loc109_.push(_loc135_);
                  _loc110_++;
               }
               this.var_1.mEggPetInfo.method_976(_loc109_);
               _loc111_ = param1.method_4();
               this.var_1.mEggPetInfo.method_891(_loc111_);
               if(param1.method_11())
               {
                  _loc112_ = param1.method_6(class_7.const_19);
                  _loc113_ = param1.method_4();
                  _loc114_ = this.var_1.mEggPetInfo.GetPetDataByIDIteration(_loc112_,_loc113_);
                  this.var_1.mEggPetInfo.SetRestingPetData(_loc114_,class_7.const_220);
               }
               if(param1.method_11())
               {
                  _loc112_ = param1.method_6(class_7.const_19);
                  _loc113_ = param1.method_4();
                  _loc114_ = this.var_1.mEggPetInfo.GetPetDataByIDIteration(_loc112_,_loc113_);
                  this.var_1.mEggPetInfo.SetRestingPetData(_loc114_,class_7.const_199);
               }
               if(param1.method_11())
               {
                  _loc112_ = param1.method_6(class_7.const_19);
                  _loc113_ = param1.method_4();
                  _loc114_ = this.var_1.mEggPetInfo.GetPetDataByIDIteration(_loc112_,_loc113_);
                  this.var_1.mEggPetInfo.SetRestingPetData(_loc114_,class_7.const_187);
               }
               if(param1.method_11())
               {
                  _loc136_ = param1.method_6(class_7.const_19);
                  _loc137_ = param1.method_4();
                  _loc138_ = param1.method_4();
                  _loc139_ = this.var_1.mEggPetInfo.GetPetDataByIDIteration(_loc136_,_loc137_);
                  if(_loc139_)
                  {
                     this.var_1.mEggPetInfo.method_1548(_loc139_,_loc138_);
                  }
               }
            }
            _loc62_ = param1.method_13();
            _loc63_ = param1.method_13();
            _loc64_ = param1.method_13();
            _loc65_ = param1.method_13();
            _loc66_ = param1.method_4();
            this.var_1.mNewsData.method_690(_loc62_,_loc63_,_loc64_,_loc65_,_loc66_);
         }
         var _loc31_:int = int(param1.method_6(Game.const_209));
         _loc18_ = Game.method_233(_loc31_);
         var _loc32_:Boolean = param1.method_11();
         if(_loc32_ && Boolean(_loc18_))
         {
            _loc48_ = 0;
            while(_loc48_ < class_118.const_43)
            {
               if(param1.method_11())
               {
                  _loc141_ = class_118.method_277(_loc48_);
                  _loc142_ = 1;
                  _loc143_ = param1.method_6(class_118.const_127);
                  _loc142_ += param1.method_6(_loc141_);
                  _loc140_ = class_14.var_368[_loc18_][_loc143_];
                  _loc16_.var_58[_loc48_] = new class_148(_loc140_,_loc142_);
               }
               else
               {
                  _loc16_.var_58[_loc48_] = new class_148(null,0);
               }
               _loc48_++;
            }
            if(this.var_1.mAbilityBook)
            {
               this.var_1.mAbilityBook.DefaultMasterRanks(_loc16_,_loc18_);
            }
         }
         this.var_1.method_1164();
         this.var_1.method_1649(_loc2_,_loc6_,_loc8_,_loc9_,_loc10_,_loc12_,_loc16_,_loc18_,_loc5_,this.var_1.mEggPetInfo.mRestingPetList);
         this.var_1.method_708(_loc4_);
         this.var_1.mMammothIdols = _loc13_;
         this.var_1.mbShowHigher = _loc14_;
         var _loc33_:EntType = this.var_1.clientEnt ? this.var_1.clientEnt.entType : _loc33_;
         if(Boolean(_loc33_) && Boolean(_loc7_))
         {
            this.var_1.method_1239(_loc6_,_loc33_.className,_loc8_,_loc7_);
         }
         if(_loc30_)
         {
            this.var_1.method_365(_loc54_);
            if(Boolean(this.var_1.mBuildingInfo) && Boolean(_loc33_))
            {
               this.var_1.mBuildingInfo.method_1492(_loc19_);
               this.var_1.mBuildingInfo.method_1430(_loc20_);
               this.var_1.mBuildingInfo.method_382(class_105.method_1596(_loc33_.className),_loc21_);
               this.var_1.mBuildingInfo.method_382(class_105.method_1628(_loc33_.className),_loc22_);
               this.var_1.mBuildingInfo.method_382(class_105.method_1706(_loc33_.className),_loc23_);
               this.var_1.mBuildingInfo.method_1980(_loc24_);
               this.var_1.mBuildingInfo.method_1728(_loc25_);
            }
            if(Boolean(this.var_1.mAbilityBook) && Boolean(_loc33_))
            {
               this.var_1.mAbilityBook.method_1311(_loc33_.className);
            }
         }
         if(!_loc17_)
         {
            _loc17_ = this.var_1.mMissionInfoList;
            this.var_1.mMissionInfoList = new Array();
         }
         this.var_1.method_1794(_loc17_);
         this.var_1.level.method_528(_loc15_);
         var _loc34_:uint = 1;
         while(_loc34_ < EntType.MAX_SLOTS)
         {
            _loc144_ = param1.method_11() ? param1.method_6(GearType.GEARTYPE_BITSTOSEND) : 0;
            if(this.var_1.clientEnt)
            {
               this.var_1.clientEnt.mEquipGear[_loc34_] = _loc144_;
            }
            _loc34_++;
         }
         var _loc35_:uint = param1.method_4();
         if(Boolean(_loc35_ ? class_14.var_464[_loc35_] : null))
         {
            this.var_1.clientEnt.method_525(null);
         }
         var _loc36_:uint = param1.method_4();
         var _loc37_:uint = param1.method_4();
         if((Boolean(_loc36_ ? this.var_1.mEggPetInfo.GetPetDataByIDIteration(_loc36_,_loc37_) : null)) && Boolean(this.var_1.clientEnt))
         {
            this.var_1.clientEnt.ChangePet(null);
            this.var_1.mEggPetInfo.SetActivePetData(null);
         }
         this.var_1.mEggPetInfo.method_588();
         var _loc38_:uint = param1.method_4();
         var _loc39_:uint = param1.method_4();
         var _loc40_:class_3 = class_14.var_419[_loc38_];
         if(Boolean(_loc40_) && Boolean(this.var_1.clientEnt))
         {
            this.var_1.clientEnt.method_190(_loc40_);
            this.var_1.screenHudTopRight.Refresh();
         }
         var _loc41_:class_3 = class_14.var_419[_loc39_];
         if(_loc41_)
         {
            this.var_1.QueuePotion(_loc41_);
         }
         this.method_933(param1);
         var _loc42_:uint = param1.method_4();
         _loc48_ = 0;
         while(_loc48_ < _loc42_)
         {
            _loc145_ = param1.method_13();
            _loc146_ = param1.method_13();
            this.var_1.level.method_474(_loc145_,_loc146_);
            _loc48_++;
         }
         var _loc43_:uint = param1.method_4();
         _loc48_ = 0;
         while(_loc48_ < _loc43_)
         {
            _loc147_ = param1.method_4();
            _loc148_ = param1.method_13();
            _loc149_ = param1.method_13();
            _loc150_ = this.var_1.method_111(_loc147_);
            if(_loc150_)
            {
               _loc150_.method_526(_loc148_,_loc149_,true);
            }
            _loc48_++;
         }
         var _loc44_:Entity = this.var_1.clientEnt;
         if(_loc44_)
         {
            if(_loc30_)
            {
               this.var_1.screenKeybind.UpdateHotbarKeys();
               this.var_1.method_1657(_loc44_.mEquipGear);
               this.var_1.method_709();
            }
            this.var_1.var_1922 = false;
            this.var_1.bWaitingForChangeMasterClassResponse = false;
            if(this.var_1.var_2080 && Boolean(_loc44_.mEquipMount))
            {
               _loc157_ = PowerType.var_440;
               _loc158_ = Boolean(_loc157_) && Boolean(_loc157_.var_381) ? class_14.buffTypesDict[_loc157_.var_381[0]] : null;
               if(_loc158_)
               {
                  _loc44_.combatState.AddBuff(_loc158_,_loc44_,0,_loc157_.powerID);
               }
            }
            if(this.var_1.var_2022 && Boolean(_loc44_.mEquipPet))
            {
               _loc159_ = class_14.powerTypesDict[_loc44_.mEquipPet.mPetType.var_1138];
               _loc160_ = Boolean(_loc159_) && Boolean(_loc159_.var_381) ? class_14.buffTypesDict[_loc159_.var_381[0]] : null;
               if(_loc160_)
               {
                  _loc44_.combatState.AddBuff(_loc160_,_loc44_,0,_loc159_.powerID);
               }
            }
            if(_loc44_.mMasterClass == "frostwarden")
            {
               _loc44_.var_31 = _loc44_.combatState.var_1660;
            }
            else
            {
               _loc44_.var_31 = 0;
            }
            this.var_1.method_114(_loc44_.var_31);
            if(Boolean(_loc44_.hudPowers) && _loc44_.hudPowers.length >= 6)
            {
               _loc48_ = 4;
               while(_loc48_ <= 6)
               {
                  if(Boolean(_loc44_.hudPowers[_loc48_]) && Boolean(_loc44_.hudPowers[_loc48_].coolDownTime))
                  {
                     _loc44_.combatState.var_114[_loc44_.hudPowers[_loc48_].powerID] = this.var_1.mTimeThisTick + _loc44_.hudPowers[_loc48_].coolDownTime;
                  }
                  _loc48_++;
               }
            }
         }
         this.var_1.var_2080 = false;
         this.var_1.var_2022 = false;
         if(_loc30_)
         {
            this.var_1.screenInteractiveTutorial.CheckCompletedTutorials();
         }
         var _loc45_:Level = this.var_1.level;
         if(Boolean(_loc45_.internalName) && Boolean(Level.method_73(_loc45_.internalName)) && !_loc45_.var_333)
         {
            if(_loc45_.internalName != "NewbieRoad" || this.var_1.mTutorialStage >= Game.const_355)
            {
               this.var_1.var_2306.Display();
            }
         }
         if(!(DevSettings.flags & DevSettings.DEVFLAG_MASTER_CLIENT))
         {
            Game.var_172.method_973();
         }
      }
      
      private function method_672(param1:Packet) : EntTypeGear
      {
         var _loc2_:uint = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
         var _loc3_:uint = param1.method_6(GearType.const_176);
         var _loc4_:uint = param1.method_6(class_64.const_101);
         var _loc5_:uint = param1.method_6(class_64.const_101);
         var _loc6_:uint = param1.method_6(class_64.const_101);
         var _loc7_:uint = param1.method_6(class_21.const_50);
         var _loc8_:uint = param1.method_6(class_21.const_50);
         var _loc9_:String = Game.method_110(_loc2_,_loc3_);
         var _loc10_:GearType = class_14.var_421[_loc9_];
         return _loc10_ ? new EntTypeGear(_loc10_.gearName,_loc4_,_loc5_,_loc6_,_loc7_,_loc8_) : null;
      }
      
      private function method_870(param1:String, param2:Packet) : String
      {
         var _loc17_:EntTypeGear = null;
         if(!param2.method_6(1))
         {
            return null;
         }
         var _loc3_:String = param2.method_13();
         var _loc4_:String = EntType.PALADIN_OPTIONS_FILE;
         if(_loc3_ == "Mage")
         {
            _loc4_ = EntType.MAGE_OPTIONS_FILE;
         }
         else if(_loc3_ == "Rogue")
         {
            _loc4_ = EntType.ROGUE_OPTIONS_FILE;
         }
         var _loc5_:String = param2.method_13();
         var _loc6_:String = param2.method_13();
         var _loc7_:String = param2.method_13();
         var _loc8_:String = param2.method_13();
         var _loc9_:String = param2.method_13();
         var _loc10_:uint = param2.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc11_:uint = param2.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc12_:uint = param2.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc13_:uint = param2.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc14_:Vector.<EntTypeGear> = new Vector.<EntTypeGear>();
         var _loc15_:uint = 1;
         while(_loc15_ < EntType.MAX_SLOTS)
         {
            _loc17_ = param2.method_11() ? this.method_672(param2) : null;
            if(_loc17_)
            {
               _loc14_.push(_loc17_);
            }
            _loc15_++;
         }
         var _loc16_:String = EntType.method_97(param1,_loc3_,0,_loc14_,_loc5_,_loc6_,_loc7_,_loc8_,_loc9_,_loc10_,_loc11_,_loc12_,_loc13_);
         EntType.method_57(_loc16_,"Player");
         return _loc16_;
      }
      
      private function method_1602(param1:Packet) : void
      {
         var _loc20_:int = 0;
         var _loc21_:int = 0;
         var _loc22_:uint = 0;
         var _loc23_:uint = 0;
         var _loc24_:uint = 0;
         var _loc25_:uint = 0;
         var _loc26_:uint = 0;
         var _loc27_:uint = 0;
         var _loc28_:uint = 0;
         var _loc29_:uint = 0;
         var _loc30_:uint = 0;
         var _loc31_:uint = 0;
         var _loc32_:* = null;
         var _loc33_:class_9 = null;
         var _loc34_:class_9 = null;
         var _loc35_:class_9 = null;
         var _loc36_:class_9 = null;
         var _loc37_:class_9 = null;
         var _loc4_:uint = param1.method_4();
         var _loc5_:uint = param1.method_4();
         var _loc6_:String = param1.method_13();
         var _loc7_:Point = null;
         var _loc8_:Boolean = param1.method_11();
         if(_loc8_)
         {
            var _loc2_:int = int(param1.method_4());
            var _loc3_:int = int(param1.method_4());
         }
         var _loc9_:String = param1.method_13();
         var _loc10_:uint = param1.method_4();
         var _loc11_:String = param1.method_13();
         var _loc12_:uint = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         var _loc13_:uint = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
         var _loc14_:String = param1.method_13();
         var _loc15_:String = param1.method_13();
         var _loc16_:String = param1.method_13();
         var _loc17_:Boolean = param1.method_11();
         var _loc18_:Boolean = param1.method_11();
         if(_loc18_)
         {
            _loc20_ = param1.method_45();
            _loc21_ = param1.method_45();
            _loc7_ = new Point(_loc20_,_loc21_);
         }
         var _loc19_:Boolean = param1.method_11();
         if(_loc19_)
         {
            this.var_1.method_1178();
            _loc23_ = 0;
            _loc24_ = class_9.const_851;
            _loc22_ = param1.method_4();
            this.var_1.level.var_2744 = _loc22_;
            this.var_1.var_2619 = _loc22_ != _loc4_;
            _loc25_ = param1.method_6(Game.const_209);
            _loc26_ = param1.method_6(class_9.const_28);
            _loc27_ = param1.method_6(class_9.const_28);
            _loc28_ = param1.method_6(class_9.const_28);
            _loc29_ = param1.method_6(class_9.const_28);
            _loc30_ = param1.method_6(class_9.const_28);
            _loc31_ = param1.method_6(class_9.const_129);
            _loc32_ = Game.method_233(_loc25_) + "Tower";
            _loc32_ = _loc32_.charAt(0).toUpperCase() + _loc32_.substr(1);
            _loc33_ = class_9.method_94("Forge",_loc26_);
            if(_loc33_)
            {
               this.var_1.var_163[_loc33_.type] = _loc33_;
            }
            _loc34_ = class_9.method_94("Keep",_loc27_);
            if(_loc34_)
            {
               this.var_1.var_163[_loc34_.type] = _loc34_;
            }
            _loc35_ = class_9.method_94(_loc32_,_loc28_);
            if(_loc35_)
            {
               this.var_1.var_163[_loc35_.type] = _loc35_;
            }
            _loc36_ = class_9.method_94("Tome",_loc29_);
            if(_loc36_)
            {
               this.var_1.var_163[_loc36_.type] = _loc36_;
            }
            _loc37_ = class_9.method_94("Barn",_loc30_);
            if(_loc37_)
            {
               this.var_1.var_163[_loc37_.type] = _loc37_;
            }
            if(_loc31_)
            {
               this.var_1.var_163["Scaffolding"] = _loc31_;
            }
         }
         if(this.var_1.gameState == Game.STATE_LOGIN)
         {
            this.var_1.method_1716();
         }
         if(_loc8_)
         {
            _loc7_ = new Point(0,0);
         }
         this.var_1.var_1274 = _loc6_;
         this.var_1.var_1025 = _loc7_;
         this.var_1.main.var_2392 = _loc9_;
         this.var_1.main.var_2363 = _loc10_;
         this.var_1.method_282(_loc4_,_loc11_,_loc12_,_loc13_,_loc14_,_loc15_,_loc16_,_loc17_);
      }
      
      private function method_1565(param1:Packet) : void
      {
         this.var_1.targetDoor = param1.method_4();
         this.var_1.var_1274 = param1.method_13();
         this.var_1.var_2115 = true;
      }
      
      private function method_1419(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:Boolean = param1.method_11();
         if(_loc2_ == "Account created, but your character name is taken. Please choose a new name." || _loc2_ == "Character name is unavailable. Please choose a new name.")
         {
            this.var_1.var_141.method_1848();
         }
         this.var_1.var_94.method_71(_loc2_,true);
         if(_loc3_ && Boolean(this.var_1.serverConn))
         {
            this.var_1.serverConn.method_205();
            this.var_1.serverConn = null;
         }
      }
      
      private function method_1155(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         this.var_1.clientEnt.method_1510(_loc2_);
      }
      
      private function method_1191(param1:Packet) : void
      {
         var _loc6_:uint = 0;
         var _loc7_:uint = 0;
         var _loc8_:String = null;
         var _loc9_:GearType = null;
         var _loc10_:uint = 0;
         var _loc11_:class_8 = null;
         var _loc12_:uint = 0;
         var _loc13_:uint = 0;
         var _loc14_:Point = null;
         var _loc15_:uint = 0;
         var _loc16_:class_15 = null;
         var _loc17_:uint = 0;
         var _loc18_:class_21 = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = param1.method_45();
         var _loc4_:int = param1.method_45();
         var _loc5_:Loot = null;
         if(param1.method_11())
         {
            _loc6_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
            _loc7_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
            _loc8_ = Game.method_110(_loc6_,_loc7_);
            _loc9_ = class_14.var_421[_loc8_];
            if(_loc9_)
            {
               _loc5_ = new Loot(this.var_1,_loc2_,new Point(_loc3_,_loc4_),_loc9_,null,0,0,null,null);
               this.var_1.var_326.push(_loc5_);
            }
         }
         else if(param1.method_11())
         {
            _loc10_ = param1.method_4();
            _loc11_ = class_14.var_629[_loc10_];
            if(_loc11_)
            {
               _loc5_ = new Loot(this.var_1,_loc2_,new Point(_loc3_,_loc4_),null,_loc11_,0,0,null,null);
               this.var_1.var_326.push(_loc5_);
            }
         }
         else if(param1.method_11())
         {
            _loc12_ = param1.method_4();
            _loc5_ = new Loot(this.var_1,_loc2_,new Point(_loc3_,_loc4_),null,null,_loc12_,0,null,null);
            this.var_1.var_326.push(_loc5_);
         }
         else if(param1.method_11())
         {
            _loc13_ = param1.method_4();
            _loc14_ = new Point(_loc3_,_loc4_);
            _loc5_ = new Loot(this.var_1,_loc2_,_loc14_,null,null,0,_loc13_,null,null);
            this.var_1.var_326.push(_loc5_);
            if(Boolean(this.var_1.clientEnt) && this.var_1.clientEnt.combatState.var_2036)
            {
               _loc14_.x += Math.random() * 60 - 30;
               _loc5_ = new Loot(this.var_1,0,_loc14_,null,null,0,0,null,null,Loot.const_1236);
               this.var_1.var_326.push(_loc5_);
            }
         }
         else if(param1.method_11())
         {
            _loc15_ = param1.method_4();
            _loc16_ = class_14.var_838[_loc15_];
            if(_loc16_)
            {
               _loc5_ = new Loot(this.var_1,_loc2_,new Point(_loc3_,_loc4_),null,null,0,0,_loc16_,null);
               this.var_1.var_326.push(_loc5_);
            }
         }
         else
         {
            _loc17_ = param1.method_4();
            _loc18_ = class_14.var_194[_loc17_];
            if(_loc18_)
            {
               _loc5_ = new Loot(this.var_1,_loc2_,new Point(_loc3_,_loc4_),null,null,0,0,null,_loc18_);
               this.var_1.var_326.push(_loc5_);
            }
         }
      }
      
      private function method_2110(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
      }
      
      private function method_1343(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:Boolean = param1.method_11();
         this.var_1.clientEnt.method_1796(_loc2_,_loc3_,_loc4_);
      }
      
      private function method_1612(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
         var _loc3_:uint = param1.method_6(GearType.const_176);
         var _loc4_:Boolean = param1.method_11();
         this.var_1.clientEnt.GainNewGear(_loc2_,_loc3_,_loc4_);
      }
      
      private function method_1797(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Boolean = param1.method_11();
         this.var_1.clientEnt.GainMoney(_loc2_,_loc3_);
      }
      
      private function method_1676(param1:Packet) : void
      {
         var _loc2_:int = int(param1.method_4());
         this.var_1.clientEnt.GainMoney(-_loc2_,false);
      }
      
      private function method_1000(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:uint = param1.method_4();
         this.var_1.mMammothIdols -= _loc3_;
         class_53.method_721("Purchase:" + _loc2_,_loc3_,"BMI");
      }
      
      private function method_1441(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         this.var_1.loginMaxChars = _loc2_;
      }
      
      private function method_1193(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Boolean = param1.method_11();
         this.var_1.clientEnt.GainMount(_loc2_,_loc3_);
      }
      
      private function method_1495(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(class_7.const_19);
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = param1.method_6(class_7.const_75);
         var _loc5_:Boolean = param1.method_11();
         this.var_1.mEggPetInfo.method_1474(_loc2_,_loc3_,_loc4_,_loc5_);
      }
      
      private function method_3000(param1:Entity, param2:int, param3:Boolean) : void
      {
         var _loc4_:int = 0;
         if(!param1 || param2 <= 0)
         {
            return;
         }
         _loc4_ = param1.maxHP - param1.currHP;
         if(_loc4_ <= 0)
         {
            param1.currHP = param1.maxHP;
            if(param1.id == this.var_1.clientEntID)
            {
               this.var_1.method_184(param1.currHP);
            }
            return;
         }
         if(param2 > _loc4_)
         {
            param2 = _loc4_;
         }
         param1.TakeDamage(-param2,param3);
      }
      
      private function method_1408(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = int(param1.method_4());
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            this.method_3000(_loc4_,_loc3_,_loc4_ != this.var_1.clientEnt);
         }
      }
      
      private function method_1375(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         if(this.var_1.clientEnt)
         {
            this.var_1.clientEnt.StartSkit(_loc2_,true,this.var_1.clientEnt);
         }
         this.var_1.mbTransferMode = false;
      }
      
      private function method_1249(param1:Packet) : void
      {
         this.var_1.mbTransferMode = true;
      }
      
      private function method_1809(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         this.var_1.screenChat.ReadUnsafeStatusText(_loc2_);
         this.var_1.mbTransferMode = false;
      }
      
      private function method_1444(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.level.method_474(_loc2_,_loc3_);
      }
      
      private function method_1844(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         this.var_1.screenChat.ReadUnsafeStatusText(_loc2_);
      }
      
      private function method_1791(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.method_785(_loc2_,null,_loc3_);
      }
      
      private function method_1332(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.method_785(this.var_1.clientEntName,_loc2_,_loc3_);
      }
      
      private function method_1560(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.method_446("Guild",_loc2_,_loc3_);
      }
      
      private function method_1756(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.method_446("Officer",_loc2_,_loc3_);
      }
      
      private function method_1387(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.method_446("Party",_loc2_,_loc3_);
      }
      
      private function method_933(param1:Packet) : void
      {
         var _loc7_:String = null;
         var _loc8_:uint = 0;
         var _loc9_:uint = 0;
         var _loc10_:String = null;
         var _loc11_:String = null;
         var _loc12_:uint = 0;
         var _loc13_:uint = 0;
         var _loc2_:uint = 0;
         var _loc3_:String = null;
         var _loc4_:Entity = this.var_1.clientEnt;
         var _loc5_:EntType = _loc4_ ? _loc4_.entType : null;
         var _loc6_:Vector.<Friend> = new Vector.<Friend>();
         if(param1.method_11())
         {
            _loc3_ = param1.method_13();
            _loc2_ = param1.method_6(Entity.const_172);
            _loc7_ = this.var_1.clientEntName;
            _loc8_ = param1.method_4();
            _loc9_ = 0;
            while(_loc9_ < _loc8_)
            {
               _loc10_ = param1.method_13();
               _loc11_ = Entity.method_244(param1.method_6(Entity.const_244));
               _loc12_ = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
               _loc13_ = param1.method_6(Entity.const_172);
               if(_loc7_ != _loc10_)
               {
                  _loc6_.push(new Friend(_loc10_,null,true,_loc12_,_loc11_,false,_loc13_));
               }
               _loc9_++;
            }
            if(_loc4_ && _loc5_ && Boolean(_loc5_.entName))
            {
               _loc6_.push(new Friend(_loc5_.entName,null,true,_loc4_.mExpLevel,_loc5_.className,false,_loc2_));
            }
         }
         if(_loc4_)
         {
            _loc4_.method_436(_loc3_,_loc2_);
         }
         this.var_1.var_124 = _loc6_;
         this.var_1.screenFriend.method_159(this.var_1.var_124);
      }
      
      private function method_1942(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:String = param1.method_13();
         if(!this.method_1203(_loc2_,_loc3_,_loc4_))
         {
            this.var_1.var_2224.Display(_loc4_,_loc2_,_loc3_);
            this.var_1.screenChat.ReadUnsafeStatusText(_loc4_);
         }
      }
      
      private function method_1036(param1:Packet) : void
      {
         var _loc6_:class_133 = null;
         var _loc2_:String = param1.method_13();
         var _loc3_:uint = param1.method_91();
         var _loc4_:uint = param1.method_91();
         var _loc5_:uint = 1;
         for each(_loc6_ in this.var_1.groupmates)
         {
            if(_loc6_.charName == _loc2_)
            {
               _loc6_.method_320(_loc3_,_loc4_,_loc5_,_loc2_);
               break;
            }
            _loc5_++;
         }
      }
      
      private function method_1940(param1:Packet) : void
      {
         var _loc4_:Boolean = false;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:uint = 0;
         var _loc8_:uint = 0;
         var _loc9_:Boolean = false;
         var _loc10_:Boolean = false;
         var _loc11_:String = null;
         var _loc12_:Boolean = false;
         var _loc13_:String = null;
         var _loc14_:class_133 = null;
         var _loc2_:Vector.<class_133> = new Vector.<class_133>();
         var _loc3_:Boolean = param1.method_11();
         if(_loc3_)
         {
            _loc4_ = param1.method_11();
            _loc5_ = param1.method_4();
            _loc6_ = 0;
            while(_loc6_ < _loc5_)
            {
               _loc7_ = 0;
               _loc8_ = 0;
               _loc9_ = param1.method_11();
               _loc10_ = param1.method_11();
               _loc11_ = param1.method_13();
               _loc12_ = false;
               _loc13_ = this.var_1.level.internalName;
               if(_loc10_)
               {
                  _loc7_ = param1.method_91();
                  _loc8_ = param1.method_91();
                  _loc12_ = param1.method_11();
                  if(!_loc12_)
                  {
                     _loc13_ = param1.method_13();
                  }
               }
               if(_loc11_ != this.var_1.clientEntName)
               {
                  _loc14_ = new class_133(_loc11_,_loc9_,_loc10_,_loc12_,_loc13_,this.var_1);
                  _loc14_.method_320(_loc7_,_loc8_,_loc2_.length + 1,_loc11_);
                  _loc2_.push(_loc14_);
               }
               else
               {
                  this.var_1.bAmGroupLeader = _loc9_;
               }
               _loc6_++;
            }
         }
         this.var_1.bGroupIsLocked = _loc4_;
         class_133.method_956(this.var_1,_loc2_,true);
         if(_loc3_ && this.var_1.screenChat.var_1006 == "Say")
         {
            this.var_1.screenChat.method_109("Party");
         }
         else if(!_loc3_ && this.var_1.screenChat.var_1006 == "Party")
         {
            this.var_1.screenChat.method_109("Say");
         }
      }
      
      private function method_1635(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_91();
         var _loc4_:Door = this.var_1.level.GetDoorFromID(_loc2_);
         if(Boolean(_loc4_) && _loc3_ != Door.DOORSTATE_CLOSED)
         {
            _loc4_.doorState = _loc3_;
            _loc4_.var_1260 = param1.method_13();
            if(_loc3_ == Door.DOORSTATE_MISSIONREPEAT)
            {
               _loc4_.var_2671 = param1.method_6(class_119.const_228);
            }
            if(_loc4_.var_517)
            {
               _loc4_.var_517.method_42();
               _loc4_.var_517.DestroyUIMovieClip();
            }
            _loc4_.var_517 = null;
         }
      }
      
      private function method_1142(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_6(class_20.const_297);
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.mEquipMount = class_14.var_464[_loc3_];
         }
      }
      
      private function method_1279(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_6(class_3.const_69);
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.method_190(_loc3_ ? class_14.var_419[_loc3_] : null);
         }
      }
      
      private function method_1217(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_6(class_7.const_19);
         var _loc4_:uint = param1.method_6(class_7.const_75);
         var _loc5_:uint = param1.method_6(class_7.const_19);
         var _loc6_:uint = param1.method_6(class_7.const_75);
         var _loc7_:uint = param1.method_6(class_7.const_19);
         var _loc8_:uint = param1.method_6(class_7.const_75);
         var _loc9_:uint = param1.method_6(class_7.const_19);
         var _loc10_:uint = param1.method_6(class_7.const_75);
         var _loc11_:Entity = this.var_1.GetEntFromID(_loc2_);
         var _loc12_:class_7 = class_14.var_224[_loc3_];
         var _loc13_:class_7 = class_14.var_224[_loc5_];
         var _loc14_:class_7 = class_14.var_224[_loc7_];
         var _loc15_:class_7 = class_14.var_224[_loc9_];
         if(_loc12_)
         {
            var _loc16_:class_87 = new class_87(this.var_1,_loc12_,_loc4_,0,0);
         }
         if(_loc13_)
         {
            var _loc17_:class_87 = new class_87(this.var_1,_loc13_,_loc6_,0,0);
         }
         if(_loc14_)
         {
            var _loc18_:class_87 = new class_87(this.var_1,_loc14_,_loc8_,0,0);
         }
         if(_loc15_)
         {
            var _loc19_:class_87 = new class_87(this.var_1,_loc15_,_loc10_,0,0);
         }
         if(_loc11_)
         {
            _loc11_.mEquipPet = null;
            _loc11_.var_329[class_7.const_220] = null;
            _loc11_.var_329[class_7.const_199] = null;
            _loc11_.var_329[class_7.const_187] = null;
            _loc11_.ResetEntType(_loc11_.entType);
            if(_loc2_ == this.var_1.clientEntID && _loc11_.combatState.var_823)
            {
               _loc11_.method_343();
            }
         }
      }
      
      private function method_1394(param1:Packet) : void
      {
         var _loc4_:uint = 0;
         var _loc5_:int = 0;
         var _loc2_:uint = param1.method_4();
         var _loc3_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc3_)
         {
            _loc4_ = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
            _loc5_ = param1.method_45();
            _loc3_.method_407(_loc4_,_loc5_);
         }
      }
      
      private function method_1577(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.behaviorSpeedMod = _loc3_ * VELOCITY_DEFLATE;
            _loc4_.RecalculateSpeed();
         }
      }
      
      public function WriteChangeMaxSpeed(param1:Entity) : void
      {
         var _loc2_:Packet = new Packet(const_760);
         _loc2_.method_9(param1.id);
         _loc2_.method_9(param1.behaviorSpeedMod * VELOCITY_INFLATE);
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      private function method_1402(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = param1.method_739();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.targetOffsetY = _loc3_;
         }
      }
      
      public function WriteChangeOffsetY(param1:Entity) : void
      {
         var _loc2_:Packet = new Packet(PKTTYPE_CHANGE_OFFSET_Y);
         _loc2_.method_9(param1.id);
         _loc2_.method_706(param1.targetOffsetY);
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      private function method_1295(param1:Packet) : void
      {
         var _loc6_:uint = 0;
         var _loc7_:class_13 = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(!_loc3_)
         {
            return;
         }
         var _loc4_:String = null;
         var _loc5_:uint = param1.method_6(class_13.const_949);
         if(_loc5_ != class_13.const_1259)
         {
            _loc6_ = param1.method_4();
            _loc7_ = class_14.var_238[_loc6_];
            if(_loc7_)
            {
               _loc4_ = _loc7_.method_224(_loc5_);
            }
         }
         else if(_loc3_.cue)
         {
            _loc4_ = _loc3_.cue.sayOnInteract;
         }
         if(_loc4_)
         {
            _loc3_.StartSkit(_loc4_,true,this.var_1.clientEnt);
         }
      }
      
      private function method_1104(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.method_438(_loc3_);
         }
      }
      
      private function method_1917(param1:Packet) : void
      {
         var _loc5_:Packet = null;
         var _loc2_:int = param1.method_45();
         var _loc3_:Boolean = param1.method_11();
         this.var_1.var_936.var_787 = 0;
         var _loc4_:Entity = this.var_1.clientEnt;
         if(Boolean(_loc4_) && _loc4_.entState == Entity.const_6)
         {
            _loc4_.method_831(_loc2_,_loc3_);
            _loc5_ = new Packet(const_743);
            _loc5_.method_9(_loc4_.id);
            _loc5_.method_24(_loc2_);
            _loc5_.method_15(_loc3_);
            this.var_1.serverConn.SendPacket(_loc5_);
            if(_loc3_)
            {
               this.var_1.clientEnt.var_228 = Entity.const_429;
               this.var_1.clientEnt.combatState.AddBuff(BuffType.var_1869,this.var_1.clientEnt,0,0);
            }
         }
      }
      
      private function method_1335(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = param1.method_45();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.method_831(_loc3_,false);
         }
      }
      
      private function method_1894(param1:Packet) : void
      {
         var _loc2_:String = param1.method_13();
         this.var_1.var_936.var_787 = 0;
         this.var_1.screenChat.ReadUnsafeStatusText(_loc2_);
      }
      
      private function method_1224(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc3_)
         {
            _loc3_.method_438("");
         }
      }
      
      private function method_1813(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = param1.method_45();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            this.method_3000(_loc4_,_loc3_,true);
         }
      }
      
      private function method_1549(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:int = param1.method_45();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            this.method_3000(_loc4_,_loc3_,true);
         }
      }
      
      private function method_1473(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = param1.method_4();
         var _loc5_:int = param1.method_45();
         var _loc6_:uint = param1.method_6(Game.const_390);
         var _loc7_:Entity = this.var_1.GetEntFromID(_loc2_);
         var _loc8_:Entity = this.var_1.GetEntFromID(_loc3_);
         if(_loc7_)
         {
            _loc7_.combatState.method_294(_loc8_,_loc5_,null,_loc4_);
         }
      }
      
      public function method_1129(param1:uint, param2:String) : void
      {
         var _loc3_:Packet = new Packet(PKTTYPE_ROOM_THOUGHT);
         _loc3_.method_9(param1);
         _loc3_.method_26(param2);
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1161(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            _loc4_.StartSkit(_loc3_,true,this.var_1.clientEnt);
         }
      }
      
      private function method_1550(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         this.var_1.method_1787(_loc2_);
      }
      
      private function method_1795(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_4();
         this.var_1.method_1873(_loc2_,_loc3_);
      }
      
      private function method_1294(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = param1.method_4();
         if(param1.method_11())
         {
            _loc2_ = param1.method_6(class_119.const_228);
            _loc3_ = param1.method_4();
         }
         this.var_1.method_1472(_loc4_,_loc2_,_loc3_);
      }
      
      private function method_1122(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:Boolean = param1.method_11();
         this.var_1.method_1380(_loc2_,_loc3_);
      }
      
      public function method_1163(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(Game.const_813);
         this.var_1.method_708(_loc2_);
      }
      
      public function method_1061(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         this.var_1.method_1729(_loc2_);
      }
      
      public function method_1145(param1:Packet) : void
      {
         var _loc11_:class_13 = null;
         var _loc12_:* = false;
         var _loc13_:Mission = null;
         var _loc2_:uint = param1.method_6(class_119.const_228);
         var _loc3_:uint = param1.method_4();
         var _loc4_:uint = param1.method_4();
         var _loc5_:uint = param1.method_4();
         var _loc6_:uint = param1.method_4();
         var _loc7_:uint = param1.method_4();
         var _loc8_:uint = param1.method_4();
         var _loc9_:uint = param1.method_4();
         var _loc10_:String = this.var_1.level.internalName;
         if(_loc10_ == "TutorialBoat" || _loc10_ == "CraftTownTutorial")
         {
            this.var_1.OpenDoor(new Door("ExitMission",0,0,null,2,null));
         }
         else
         {
            _loc11_ = class_14.var_1391[_loc10_];
            if(_loc11_)
            {
               _loc13_ = this.var_1.mMissionInfoList[_loc11_.missionID];
               if(_loc13_)
               {
                  if(_loc2_ > _loc13_.var_588)
                  {
                     _loc13_.var_588 = _loc2_;
                  }
                  _loc13_.var_2806 = this.var_1.mServerGameTime;
               }
            }
            _loc12_ = this.var_1.level.var_1550.indexOf("Hard") != -1;
            this.var_1.var_1808.Display(_loc2_,_loc3_,_loc4_,_loc5_,_loc6_,_loc7_,_loc8_,_loc9_,_loc12_);
         }
         Game.var_172.method_548(_loc2_,_loc3_,_loc4_,_loc5_,_loc6_,_loc7_,_loc8_,_loc9_);
         Game.var_172.method_1855();
      }
      
      public function WriteChangeLook(param1:String, param2:String, param3:String, param4:String, param5:String, param6:uint, param7:uint) : void
      {
         var _loc8_:Packet = new Packet(const_1152);
         _loc8_.method_26(param1);
         _loc8_.method_26(param2);
         _loc8_.method_26(param3);
         _loc8_.method_26(param4);
         _loc8_.method_26(param5);
         _loc8_.method_20(EntType.CHAR_COLOR_BITSTOSEND,param6);
         _loc8_.method_20(EntType.CHAR_COLOR_BITSTOSEND,param7);
         this.var_1.serverConn.SendPacket(_loc8_);
      }
      
      public function method_1033(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         var _loc4_:String = param1.method_13();
         var _loc5_:String = param1.method_13();
         var _loc6_:String = param1.method_13();
         var _loc7_:String = param1.method_13();
         var _loc8_:uint = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc9_:uint = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         var _loc10_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc10_)
         {
            _loc10_.method_1439(_loc3_,_loc4_,_loc5_,_loc6_,_loc7_,_loc8_,_loc9_);
         }
      }
      
      private function method_1146(param1:Packet) : void
      {
         var _loc10_:EntType = null;
         var _loc11_:uint = 0;
         var _loc12_:EntTypeGear = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:uint = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
         var _loc4_:uint = param1.method_6(GearType.const_176);
         var _loc5_:uint = param1.method_6(class_64.const_101);
         var _loc6_:uint = param1.method_6(class_1.const_765);
         var _loc7_:Entity = this.var_1.GetEntFromID(_loc2_);
         var _loc8_:String = Game.method_110(_loc3_,_loc4_);
         var _loc9_:GearType = class_14.var_421[_loc8_];
         if(Boolean(_loc7_) && Boolean(_loc9_))
         {
            _loc10_ = _loc7_.entType;
            _loc11_ = 1;
            while(_loc11_ < EntType.MAX_SLOTS)
            {
               _loc12_ = _loc10_.equippedGear[_loc11_];
               if(Boolean(_loc12_) && _loc12_.gearName == _loc9_.gearName)
               {
                  if(_loc6_ == 1)
                  {
                     _loc12_.var_432 = _loc5_;
                  }
                  else if(_loc6_ == 2)
                  {
                     _loc12_.var_501 = _loc5_;
                  }
                  else if(_loc6_ == 3)
                  {
                     _loc12_.var_486 = _loc5_;
                  }
                  _loc12_.method_875();
                  _loc7_.ResetEntType(_loc10_);
                  break;
               }
               _loc11_++;
            }
         }
      }
      
      private function method_1470(param1:Packet) : void
      {
         var _loc4_:EntType = null;
         var _loc5_:uint = 0;
         var _loc6_:String = null;
         var _loc7_:String = null;
         var _loc8_:EntTypeGear = null;
         var _loc2_:uint = param1.method_4();
         var _loc3_:Entity = this.var_1.GetEntFromID(_loc2_);
         if(_loc3_)
         {
            _loc4_ = _loc3_.entType;
            _loc5_ = 1;
            while(_loc5_ < EntType.MAX_SLOTS)
            {
               if(param1.method_11())
               {
                  _loc6_ = EntType.method_523(_loc5_);
                  _loc7_ = "No" + _loc4_.className + _loc6_;
                  _loc8_ = param1.method_11() ? this.method_672(param1) : null;
                  _loc4_.equippedGear[_loc5_] = _loc8_ ? _loc8_ : new EntTypeGear(_loc7_,0,0,0);
               }
               _loc5_++;
            }
            _loc4_.gfxType = _loc4_.method_60();
            _loc3_.ResetEntType(_loc4_);
         }
      }
      
      public function WriteUpdateSingleGear(param1:Entity, param2:uint, param3:uint) : void
      {
         var _loc4_:Packet = new Packet(const_1029);
         _loc4_.method_9(param1.id);
         _loc4_.method_236(param2);
         _loc4_.method_20(GearType.GEARTYPE_BITSTOSEND,param3);
         this.var_1.serverConn.SendPacket(_loc4_);
      }
      
      public function WriteUpdateEquipment(param1:Entity, param2:Vector.<uint>) : void
      {
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc3_:Packet = new Packet(PKTTYPE_UPDATE_EQUIPMENT);
         _loc3_.method_9(param1.id);
         var _loc4_:uint = 1;
         while(_loc4_ < EntType.MAX_SLOTS)
         {
            _loc5_ = param2[_loc4_];
            _loc6_ = param1.mEquipGear[_loc4_];
            if(_loc5_ == _loc6_)
            {
               _loc3_.method_15(false);
            }
            else
            {
               _loc3_.method_15(true);
               _loc3_.method_20(GearType.GEARTYPE_BITSTOSEND,_loc5_);
            }
            _loc4_++;
         }
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1721(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_4();
         var _loc3_:String = param1.method_13();
         this.var_1.screenChat.ReceiveChat(_loc2_,_loc3_);
      }
      
      public function WriteChatMessage(param1:uint, param2:String) : void
      {
         var _loc3_:Packet = new Packet(PKTTYPE_CHAT_MESSAGE);
         _loc3_.method_9(param1);
         _loc3_.method_26(param2);
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1607(param1:Packet) : void
      {
         this.var_1.var_1909 = param1.method_13();
      }
      
      private function method_1177(param1:Packet) : void
      {
      }
      
      private function method_1170(param1:Packet) : void
      {
         var _loc2_:String = null;
         var _loc3_:String = null;
         var _loc5_:String = null;
         var _loc6_:String = null;
         var _loc7_:String = null;
         var _loc8_:String = null;
         var _loc9_:String = null;
         var _loc10_:uint = 0;
         var _loc11_:uint = 0;
         var _loc12_:uint = 0;
         var _loc13_:uint = 0;
         var _loc14_:Vector.<EntTypeGear> = null;
         var _loc15_:uint = 0;
         var _loc16_:String = null;
         var _loc17_:uint = 0;
         var _loc18_:GearType = null;
         _loc2_ = param1.method_13();
         _loc3_ = param1.method_13();
         var _loc4_:String = EntType.PALADIN_OPTIONS_FILE;
         if(_loc3_ == "Mage")
         {
            _loc4_ = EntType.MAGE_OPTIONS_FILE;
         }
         else if(_loc3_ == "Rogue")
         {
            _loc4_ = EntType.ROGUE_OPTIONS_FILE;
         }
         _loc5_ = param1.method_13();
         _loc6_ = param1.method_13();
         _loc7_ = param1.method_13();
         _loc8_ = param1.method_13();
         _loc9_ = param1.method_13();
         _loc10_ = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         _loc11_ = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         _loc12_ = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         _loc13_ = param1.method_6(EntType.CHAR_COLOR_BITSTOSEND);
         _loc14_ = new Vector.<EntTypeGear>();
         _loc15_ = 1;
         while(_loc15_ < EntType.MAX_SLOTS)
         {
            _loc17_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
            _loc18_ = _loc17_ ? class_14.gearTypes[_loc17_] : null;
            if(_loc18_)
            {
               _loc14_.push(new EntTypeGear(_loc18_.gearName,0,0,0));
            }
            _loc15_++;
         }
         _loc16_ = EntType.method_97(_loc2_,_loc3_,0,_loc14_,_loc5_,_loc6_,_loc7_,_loc8_,_loc9_,_loc10_,_loc11_,_loc12_,_loc13_);
         EntType.method_57(_loc16_,"Player");
         this.var_1.var_341.UpdatePaperDoll(_loc2_);
      }
      
      private function method_1772(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:Vector.<Object> = null;
         var _loc6_:uint = 0;
         var _loc7_:Object = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_393();
         _loc4_ = param1.method_393();
         _loc5_ = new Vector.<Object>();
         _loc6_ = 0;
         while(_loc6_ < _loc4_)
         {
            _loc7_ = new Object();
            _loc7_.name = param1.method_13();
            _loc7_.className = param1.method_13();
            _loc7_.level = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
            _loc5_.push(_loc7_);
            _loc6_++;
         }
         this.var_1.clientUserID = _loc2_;
         this.var_1.loginMaxChars = _loc3_;
         this.var_1.var_355 = _loc5_;
         if(Boolean(this.var_1.clientFacebookID) || Boolean(this.var_1.clientKongID))
         {
            this.var_1.var_934 = true;
         }
      }
      
      public function method_1353(param1:ActivePower) : void
      {
         var _loc2_:PowerType = null;
         var _loc3_:Packet = null;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         _loc2_ = param1.powerType;
         _loc3_ = new Packet(PKTTYPE_ENT_POWER_CAST);
         _loc3_.method_9(param1.var_4.id);
         _loc3_.method_9(_loc2_.powerID);
         _loc3_.method_15(param1.var_33 != null);
         if(!_loc2_.var_2846)
         {
            _loc3_.method_15(false);
         }
         else
         {
            _loc3_.method_15(true);
            _loc3_.method_24(param1.targetPos.x);
            _loc3_.method_24(param1.targetPos.y);
         }
         if(!_loc2_.bIsProjectile)
         {
            _loc3_.method_15(false);
         }
         else
         {
            _loc3_.method_15(true);
            _loc3_.method_9(param1.var_294);
         }
         _loc3_.method_15(param1.var_2521);
         if(!param1.meleeCombo && !param1.var_674)
         {
            _loc3_.method_15(false);
         }
         else
         {
            _loc3_.method_15(true);
            if(param1.meleeCombo)
            {
               _loc3_.method_15(true);
               _loc3_.method_9(param1.meleeCombo);
            }
            else
            {
               _loc3_.method_15(false);
               _loc3_.method_9(param1.var_674);
            }
         }
         if(_loc2_.var_219)
         {
            _loc3_.method_15(true);
            if(_loc2_.coolDownTime)
            {
               _loc4_ = this.var_1.mTimeThisTick;
               _loc3_.method_15(true);
               _loc3_.method_9(_loc4_);
            }
            else
            {
               _loc3_.method_15(false);
            }
            if(Boolean(_loc2_.manaCost) || _loc2_.basePowerName == "EndSentinelForm")
            {
               _loc5_ = param1.var_4.var_31;
               _loc3_.method_15(true);
               _loc3_.method_20(PowerType.const_423,_loc5_);
            }
            else
            {
               _loc3_.method_15(false);
            }
         }
         else
         {
            _loc3_.method_15(false);
         }
         this.var_1.serverConn.SendPacket(_loc3_);
      }
      
      private function method_1180(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:Boolean = false;
         var _loc5_:Entity = null;
         var _loc6_:PowerType = null;
         var _loc7_:uint = 0;
         var _loc8_:uint = 0;
         var _loc9_:uint = 0;
         var _loc10_:Point = null;
         var _loc11_:Boolean = false;
         var _loc12_:ActivePower = null;
         var _loc13_:ActivePower = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_11();
         _loc5_ = this.var_1.GetEntFromID(_loc2_);
         _loc6_ = class_14.powerTypes[_loc3_];
         if(Boolean(_loc5_) && Boolean(_loc6_))
         {
            _loc7_ = 0;
            _loc8_ = 0;
            _loc9_ = 0;
            _loc10_ = null;
            if(param1.method_11())
            {
               _loc10_ = new Point();
               _loc10_.x = param1.method_45();
               _loc10_.y = param1.method_45();
            }
            if(param1.method_11())
            {
               _loc7_ = param1.method_4();
            }
            _loc11_ = param1.method_11();
            if(param1.method_11())
            {
               if(param1.method_11())
               {
                  _loc8_ = param1.method_4();
               }
               else
               {
                  _loc9_ = param1.method_4();
               }
            }
            if(_loc6_.var_301)
            {
               _loc12_ = new ActivePower(this.var_1,_loc6_,_loc5_,null,_loc10_,_loc7_,_loc8_,_loc9_,true);
               _loc12_.method_243();
               _loc12_.method_129();
            }
            else
            {
               _loc13_ = _loc5_.combatState.mActivePower;
               if(!_loc11_ && _loc13_ && !_loc13_.var_344)
               {
                  _loc13_.method_872();
                  _loc13_.method_129();
               }
               _loc13_ = new ActivePower(this.var_1,_loc6_,_loc5_,null,_loc10_,_loc7_,_loc8_,_loc9_,true,_loc11_);
               _loc13_.var_2661 = _loc4_;
               if(_loc11_)
               {
                  _loc5_.combatState.var_554.push(_loc13_);
               }
               else
               {
                  _loc5_.combatState.mActivePower = _loc13_;
               }
            }
         }
      }
      
      public function method_1092(param1:Entity, param2:PowerType, param3:Entity, param4:int, param5:uint, param6:uint, param7:Boolean) : void
      {
         var _loc8_:Packet = null;
         _loc8_ = new Packet(PKTTYPE_ENT_POWER_HIT);
         _loc8_.method_9(param3.id);
         _loc8_.method_9(param1.id);
         _loc8_.method_24(param4);
         _loc8_.method_9(param2.powerID);
         if(!param5)
         {
            _loc8_.method_15(false);
         }
         else
         {
            _loc8_.method_15(true);
            _loc8_.method_9(param5);
         }
         if(!param6)
         {
            _loc8_.method_15(false);
         }
         else
         {
            _loc8_.method_15(true);
            _loc8_.method_9(param6);
         }
         _loc8_.method_15(param7);
         this.var_1.serverConn.SendPacket(_loc8_);
      }
      
      private function method_1957(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:int = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:uint = 0;
         var _loc9_:PowerType = null;
         var _loc10_:Entity = null;
         var _loc11_:Entity = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_45();
         _loc5_ = param1.method_4();
         _loc6_ = param1.method_11() ? param1.method_4() : _loc5_;
         _loc7_ = param1.method_11() ? param1.method_4() : 0;
         var _loc8_:Boolean = param1.method_11();
         _loc9_ = class_14.powerTypes[_loc5_];
         _loc10_ = this.var_1.GetEntFromID(_loc2_);
         _loc11_ = this.var_1.GetEntFromID(_loc3_);
         if(_loc10_)
         {
            if(Boolean(_loc11_) && Boolean(_loc9_))
            {
               _loc11_.combatState.method_884(_loc9_,_loc10_,_loc7_);
            }
            _loc10_.combatState.method_294(_loc11_,_loc4_,_loc9_,_loc6_);
         }
      }
      
      private function method_1789(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         _loc2_ = param1.method_6(Game.const_390);
         this.var_1.method_1838(true,1,_loc2_);
      }
      
      public function method_1926() : void
      {
         var _loc1_:uint = 0;
         var _loc2_:uint = 0;
         var _loc3_:int = 0;
         var _loc4_:Entity = null;
         var _loc5_:uint = 0;
         if(!this.var_1.entities)
         {
            return;
         }
         _loc1_ = this.var_1.mTimeThisTick;
         _loc2_ = this.var_1.entities.length;
         _loc3_ = 0;
         while(_loc3_ < _loc2_)
         {
            _loc4_ = this.var_1.entities[_loc3_];
            if(!(Boolean(_loc4_.var_38) || Boolean(_loc4_.var_20 & Entity.const_241)))
            {
               _loc5_ = _loc1_ - _loc4_.var_2693;
               if(_loc4_.var_1136 && _loc5_ > MIN_TIME_BETWEEN_UPDATES || _loc4_.var_1630 && _loc5_ > MIN_TIME_BETWEEN_POS_UPDATES)
               {
                  this.method_541(_loc4_);
                  _loc4_.var_2693 = _loc1_;
               }
               if(Boolean(DevSettings.flags & DevSettings.DEVFLAG_SHOWENTITYGHOST) && Boolean(DevSettings.flags & DevSettings.DEVFLAG_SERVERLOCAL))
               {
                  this.method_981(_loc4_,false);
               }
            }
            _loc3_++;
         }
      }
      
      public function method_780(param1:Entity) : void
      {
         var _loc2_:Packet = null;
         var _loc3_:int = 0;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         var _loc6_:a_Cue = null;
         _loc2_ = new Packet(PKTTYPE_ENT_FULL_UPDATE);
         _loc3_ = Math.ceil(param1.physPosX);
         _loc4_ = Math.ceil(param1.physPosY);
         _loc5_ = param1.velocity.x * VELOCITY_INFLATE;
         _loc2_.method_9(param1.id);
         _loc2_.method_24(_loc3_);
         _loc2_.method_24(_loc4_);
         _loc2_.method_24(_loc5_);
         _loc2_.method_26(param1.entType.entName);
         _loc2_.method_20(Entity.TEAM_BITS,param1.team);
         _loc2_.method_15(param1.var_20 & Entity.PLAYER ? true : false);
         _loc2_.method_706(param1.yOffsetToSimulateZ);
         _loc6_ = param1.cue;
         if(!_loc6_)
         {
            _loc2_.method_15(false);
         }
         else
         {
            _loc2_.method_15(true);
            if(!_loc6_.characterName)
            {
               _loc2_.method_15(false);
            }
            else
            {
               _loc2_.method_15(true);
               _loc2_.method_26(_loc6_.characterName);
            }
            if(!_loc6_.dramaAnim)
            {
               _loc2_.method_15(false);
            }
            else
            {
               _loc2_.method_15(true);
               _loc2_.method_26(_loc6_.dramaAnim);
            }
            if(!_loc6_.sleepAnim)
            {
               _loc2_.method_15(false);
            }
            else
            {
               _loc2_.method_15(true);
               _loc2_.method_26(_loc6_.sleepAnim);
            }
         }
         if(!param1.summonerId)
         {
            _loc2_.method_15(false);
         }
         else
         {
            _loc2_.method_15(true);
            _loc2_.method_9(param1.summonerId);
         }
         if(!param1.var_99)
         {
            _loc2_.method_15(false);
         }
         else
         {
            _loc2_.method_15(true);
            _loc2_.method_9(param1.var_99.powerID);
         }
         _loc2_.method_20(Entity.const_316,param1.entState);
         _loc2_.method_15(param1.bLeft);
         _loc2_.method_15(param1.bRunning);
         _loc2_.method_15(param1.bJumping);
         _loc2_.method_15(param1.bDropping);
         _loc2_.method_15(param1.bBackpedal);
         param1.var_959 = _loc3_;
         param1.var_874 = _loc4_;
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      public function method_981(param1:Entity, param2:Boolean) : void
      {
         var _loc3_:int = 0;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         var _loc6_:Boolean = false;
         var _loc7_:Boolean = false;
         param1.id += 1000000000;
         _loc3_ = param1.var_959;
         _loc4_ = param1.var_874;
         _loc5_ = param1.var_1258;
         _loc6_ = param1.var_1630;
         _loc7_ = param1.var_1136;
         param1.var_959 = param1.var_2569;
         param1.var_874 = param1.var_2753;
         param1.var_1258 = param1.var_2583;
         if(param2)
         {
            this.method_780(param1);
         }
         else
         {
            this.method_541(param1);
         }
         param1.var_2569 = param1.var_959;
         param1.var_2753 = param1.var_874;
         param1.var_2583 = param1.var_1258;
         param1.var_1630 = _loc6_;
         param1.var_1136 = _loc7_;
         param1.var_959 = _loc3_;
         param1.var_874 = _loc4_;
         param1.var_1258 = _loc5_;
         param1.id -= 1000000000;
      }
      
      public function method_541(param1:Entity) : void
      {
         var _loc2_:Packet = null;
         var _loc3_:int = 0;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         _loc2_ = new Packet(PKTTYPE_ENT_INCREMENTAL_UPDATE);
         _loc3_ = Math.ceil(param1.physPosX);
         _loc4_ = Math.ceil(param1.physPosY);
         _loc5_ = param1.velocity.x * VELOCITY_INFLATE;
         _loc6_ = param1.velocity.y * VELOCITY_INFLATE;
         _loc2_.method_9(param1.id);
         _loc2_.method_24(_loc3_ - param1.var_959);
         _loc2_.method_24(_loc4_ - param1.var_874);
         _loc2_.method_24(_loc5_ - param1.var_1258);
         _loc2_.method_20(Entity.const_316,param1.entState);
         _loc2_.method_15(param1.bLeft);
         _loc2_.method_15(param1.bRunning);
         _loc2_.method_15(param1.bJumping || param1.var_1872);
         _loc2_.method_15(param1.bDropping || param1.var_1715);
         _loc2_.method_15(param1.bBackpedal);
         if(param1.currSurface)
         {
            _loc2_.method_15(false);
         }
         else
         {
            _loc2_.method_15(true);
            _loc2_.method_24(_loc6_);
         }
         param1.var_1258 = _loc5_;
         param1.var_959 = _loc3_;
         param1.var_874 = _loc4_;
         param1.var_1136 = param1.var_1872 || param1.var_1715;
         param1.var_1630 = false;
         param1.var_1872 = false;
         param1.var_1715 = false;
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      private function method_1072(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:Entity = null;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         var _loc7_:Boolean = false;
         var _loc8_:* = false;
         var _loc9_:Number = NaN;
         _loc2_ = param1.method_4();
         _loc3_ = this.var_1.GetEntFromID(_loc2_);
         if(!_loc3_)
         {
            return;
         }
         _loc4_ = param1.method_45();
         _loc5_ = param1.method_45();
         _loc6_ = param1.method_45();
         _loc7_ = _loc3_.entState == Entity.const_6 && !_loc3_.var_602;
         _loc8_ = _loc3_.entState == Entity.const_78;
         _loc3_.var_38.var_914 += _loc4_;
         _loc3_.var_38.var_950 += _loc5_;
         _loc3_.var_38.var_1794 += _loc6_;
         _loc3_.entState = param1.method_6(Entity.const_316);
         _loc3_.bLeft = param1.method_11();
         _loc3_.bRunning = param1.method_11();
         _loc3_.bJumping = param1.method_11();
         _loc3_.bDropping = param1.method_11();
         _loc3_.bBackpedal = param1.method_11();
         if(param1.method_11())
         {
            _loc9_ = param1.method_45() * LinkUpdater.VELOCITY_DEFLATE;
            if(_loc3_.entState != Entity.const_6)
            {
               _loc3_.SetCurrSurface(null);
               _loc3_.velocity.y = _loc9_;
            }
         }
         if(_loc3_.entState == Entity.const_6 && !_loc7_)
         {
            if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_Seq))
            {
               _loc3_.gfx.m_Seq.method_428();
            }
            _loc3_.var_217 = this.var_1.mTimeThisTick;
            _loc3_.var_602 = false;
            if(_loc3_.var_20 & Entity.PLAYER)
            {
               ++this.var_1.level.var_1270;
            }
         }
         if(_loc3_.var_602)
         {
            _loc3_.entState = Entity.const_6;
         }
         if(_loc3_.entState != Entity.const_6)
         {
            if(_loc3_.entState == Entity.const_78 && !_loc8_)
            {
               _loc3_.BeginActive();
            }
            else if(_loc3_.entState != Entity.const_78 && _loc8_)
            {
               _loc3_.BeginSleep();
            }
         }
         if(_loc3_.var_38.var_1667)
         {
            _loc3_.var_38.var_1667 = false;
            _loc3_.var_38.var_556 = true;
            _loc3_.gfx.m_TheDO.visible = true;
         }
         _loc3_.var_38.var_1792 = this.var_1.mTimeThisTick;
      }
      
      private function method_1902(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:uint = 0;
         var _loc8_:Boolean = false;
         var _loc9_:uint = 0;
         var _loc10_:Entity = null;
         var _loc11_:BuffType = null;
         var _loc12_:Vector.<class_140> = null;
         var _loc13_:uint = 0;
         var _loc14_:int = 0;
         var _loc15_:uint = 0;
         var _loc16_:Vector.<Number> = null;
         var _loc17_:int = 0;
         var _loc18_:class_140 = null;
         var _loc19_:Number = NaN;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_4();
         _loc5_ = param1.method_4();
         _loc6_ = param1.method_4();
         _loc7_ = param1.method_4();
         _loc8_ = param1.method_11();
         if(_loc8_)
         {
            _loc12_ = new Vector.<class_140>();
            _loc13_ = param1.method_4();
            _loc14_ = 0;
            while(_loc14_ < _loc13_)
            {
               _loc9_ = param1.method_4();
               _loc15_ = param1.method_4();
               _loc16_ = new Vector.<Number>();
               _loc17_ = 0;
               while(_loc17_ < _loc15_)
               {
                  _loc19_ = param1.method_560();
                  _loc16_.push(_loc19_);
                  _loc17_++;
               }
               _loc18_ = new class_140(_loc9_,_loc16_);
               _loc12_.push(_loc18_);
               _loc14_++;
            }
         }
         _loc10_ = this.var_1.GetEntFromID(_loc2_);
         _loc11_ = class_14.buffTypes[_loc4_];
         if(Boolean(_loc10_) && Boolean(_loc11_))
         {
            _loc10_.combatState.method_522(_loc11_,_loc3_,_loc7_,_loc6_,_loc5_,_loc12_);
         }
      }
      
      public function method_1262(param1:Entity, param2:uint, param3:uint, param4:uint, param5:uint, param6:uint, param7:Vector.<class_140>) : void
      {
         var _loc8_:Packet = null;
         _loc8_ = new Packet(PKTTYPE_ENT_ADD_BUFF);
         _loc8_.method_9(param1.id);
         _loc8_.method_9(param2);
         _loc8_.method_9(param3);
         _loc8_.method_9(param5);
         _loc8_.method_9(param4);
         _loc8_.method_9(param6);
         _loc8_.method_15(param7 != null);
         if(param7)
         {
            _loc8_.method_9(param7.length);
            var _loc9_:int = 0;
            while(0 < param7.length)
            {
               _loc8_.method_9(param7[0].powerNodeTypeID);
               _loc8_.method_9(param7[0].modValue.length);
               var _loc10_:int = 0;
               while(0 < param7[0].modValue.length)
               {
                  _loc8_.method_309(param7[0].modValue[0]);
                  _loc10_++;
               }
               _loc9_++;
            }
         }
         this.var_1.serverConn.SendPacket(_loc8_);
      }
      
      private function method_1276(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:Entity = null;
         var _loc6_:BuffType = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_4();
         _loc5_ = this.var_1.GetEntFromID(_loc2_);
         _loc6_ = class_14.buffTypes[_loc4_];
         if(Boolean(_loc5_) && Boolean(_loc6_))
         {
            _loc5_.combatState.method_1278(_loc6_,_loc3_);
         }
      }
      
      public function method_1837(param1:Entity, param2:int, param3:uint) : void
      {
         var _loc4_:Packet = null;
         _loc4_ = new Packet(PKTTYPE_ENT_REMOVE_BUFF);
         _loc4_.method_9(param1.id);
         _loc4_.method_9(param2);
         _loc4_.method_9(param3);
         this.var_1.serverConn.SendPacket(_loc4_);
      }
      
      private function method_1018(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc4_:Entity = null;
         _loc2_ = param1.method_4();
         var _loc3_:Boolean = param1.method_11();
         _loc4_ = this.var_1.GetEntFromID(_loc2_);
         if(Boolean(_loc4_) && Boolean(_loc4_.var_38))
         {
            _loc4_.var_38.var_2778 = true;
         }
      }
      
      public function method_1397(param1:Entity) : void
      {
         var _loc2_:Packet = null;
         _loc2_ = new Packet(PKTTYPE_ENT_DESTROY);
         _loc2_.method_9(param1.id);
         this.var_1.serverConn.SendPacket(_loc2_);
      }
      
      private function method_1828(param1:uint, param2:String, param3:uint, param4:int, param5:int, param6:uint, param7:String) : Entity
      {
         var _loc8_:Entity = null;
         var _loc9_:a_Cue = null;
         var _loc10_:a_Cue = null;
         for each(_loc8_ in this.var_1.entities)
         {
            if(!(!_loc8_ || !_loc8_.bIAmValid || _loc8_.id == param1))
            {
               if(!(!(_loc8_.var_20 & Entity.REMOTE) || Boolean(_loc8_.var_20 & Entity.PLAYER)))
               {
                  if(!(_loc8_.team != param3 || _loc8_.summonerId != param6))
                  {
                     if(!(!_loc8_.entType || _loc8_.entType.entName != param2))
                     {
                        if(param7)
                        {
                           _loc9_ = _loc8_.cue;
                           _loc10_ = this.var_1.level.var_1046[param7];
                           if(_loc9_ != _loc10_)
                           {
                              continue;
                           }
                        }
                        if(Math.abs(_loc8_.physPosX - param4) <= DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)
                        {
                           if(Math.abs(_loc8_.physPosY - param5) <= DUPLICATE_REMOTE_ENTITY_POSITION_TOLERANCE)
                           {
                              return _loc8_;
                           }
                        }
                     }
                  }
               }
            }
         }
         return null;
      }
      
      private function method_1615(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:String = null;
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         var _loc7_:int = 0;
         var _loc8_:uint = 0;
         var _loc9_:int = 0;
         var _loc10_:uint = 0;
         var _loc11_:String = null;
         var _loc12_:uint = 0;
         var _loc13_:Boolean = false;
         var _loc14_:Boolean = false;
         var _loc15_:Boolean = false;
         var _loc16_:uint = 0;
         var _loc17_:uint = 0;
         var _loc18_:uint = 0;
         var _loc19_:uint = 0;
         var _loc20_:uint = 0;
         var _loc21_:uint = 0;
         var _loc22_:uint = 0;
         var _loc23_:uint = 0;
         var _loc24_:uint = 0;
         var _loc25_:uint = 0;
         var _loc26_:String = null;
         var _loc27_:String = null;
         var _loc28_:uint = 0;
         var _loc29_:uint = 0;
         var _loc30_:uint = 0;
         var _loc31_:PowerType = null;
         var _loc32_:uint = 0;
         var _loc33_:uint = 0;
         var _loc34_:Boolean = false;
         var _loc35_:Boolean = false;
         var _loc36_:String = null;
         var _loc37_:class_118 = null;
         var _loc38_:Entity = null;
         var _loc39_:class_7 = null;
         var _loc40_:class_87 = null;
         var _loc41_:Vector.<class_87> = null;
         var _loc42_:class_7 = null;
         var _loc43_:class_7 = null;
         var _loc44_:class_7 = null;
         var _loc45_:class_3 = null;
         var _loc46_:Entity = null;
         var _loc47_:int = 0;
         var _loc48_:uint = 0;
         var _loc49_:uint = 0;
         var _loc50_:String = null;
         var _loc51_:class_22 = null;
         var _loc52_:uint = 0;
         var _loc53_:uint = 0;
         var _loc54_:uint = 0;
         var _loc55_:int = 0;
         var _loc56_:uint = 0;
         var _loc57_:uint = 0;
         var _loc58_:uint = 0;
         var _loc59_:uint = 0;
         var _loc60_:uint = 0;
         var _loc61_:BuffType = null;
         var _loc62_:Boolean = false;
         var _loc63_:uint = 0;
         var _loc64_:Vector.<Number> = null;
         var _loc65_:Vector.<class_140> = null;
         var _loc66_:uint = 0;
         var _loc67_:int = 0;
         var _loc68_:uint = 0;
         var _loc69_:int = 0;
         var _loc70_:class_140 = null;
         var _loc71_:Number = NaN;
         var _loc72_:Entity = null;
         var _loc73_:Entity = null;
         var _loc74_:Boolean = false;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_13();
         var _loc4_:String = this.method_870(_loc3_,param1);
         _loc5_ = param1.method_45();
         _loc6_ = param1.method_45();
         _loc7_ = param1.method_45();
         _loc8_ = param1.method_6(Entity.TEAM_BITS);
         _loc9_ = 0;
         _loc10_ = 0;
         _loc11_ = null;
         _loc12_ = 0;
         _loc13_ = false;
         _loc14_ = false;
         _loc15_ = false;
         _loc16_ = 0;
         _loc17_ = 0;
         _loc18_ = 0;
         _loc19_ = 0;
         _loc20_ = 0;
         _loc21_ = 0;
         _loc22_ = 0;
         _loc23_ = 0;
         _loc24_ = 0;
         _loc25_ = 0;
         _loc28_ = uint(Game.const_526);
         if(param1.method_11())
         {
            _loc12_ = Entity.PLAYER;
            _loc13_ = param1.method_11();
            _loc14_ = param1.method_11();
            _loc16_ = param1.method_6(class_7.const_19);
            _loc17_ = param1.method_6(class_7.const_75);
            _loc18_ = param1.method_6(class_20.const_297);
            _loc25_ = param1.method_6(class_3.const_69);
            if(param1.method_11())
            {
               _loc19_ = param1.method_6(class_7.const_19);
               _loc20_ = param1.method_6(class_7.const_75);
               _loc21_ = param1.method_6(class_7.const_19);
               _loc22_ = param1.method_6(class_7.const_75);
               _loc23_ = param1.method_6(class_7.const_19);
               _loc24_ = param1.method_6(class_7.const_75);
            }
         }
         else
         {
            _loc15_ = param1.method_11();
            _loc9_ = param1.method_739();
            if(param1.method_11())
            {
               _loc10_ = param1.method_4();
            }
         }
         if(param1.method_11())
         {
            _loc11_ = param1.method_13();
         }
         if(param1.method_11())
         {
            _loc26_ = param1.method_13();
         }
         if(param1.method_11())
         {
            _loc27_ = param1.method_13();
         }
         _loc29_ = param1.method_11() ? param1.method_4() : 0;
         _loc30_ = param1.method_11() ? param1.method_4() : 0;
         _loc31_ = _loc30_ ? class_14.powerTypes[_loc30_] : null;
         _loc32_ = 0;
         _loc33_ = param1.method_6(Entity.const_316);
         _loc34_ = param1.method_11();
         _loc36_ = "";
         _loc37_ = new class_118(this.var_1);
         if(_loc12_ == Entity.PLAYER)
         {
            _loc32_ = param1.method_6(Entity.MAX_CHAR_LEVEL_BITS);
            _loc28_ = param1.method_6(Game.const_209);
            _loc35_ = param1.method_11();
            if(_loc35_)
            {
               _loc50_ = Game.method_233(_loc28_);
               _loc49_ = 0;
               while(_loc49_ < class_118.const_43)
               {
                  if(param1.method_11())
                  {
                     _loc52_ = class_118.method_277(_loc49_);
                     _loc53_ = 1;
                     _loc54_ = param1.method_6(class_118.const_127);
                     _loc53_ += param1.method_6(_loc52_);
                     _loc51_ = class_14.var_368[_loc50_][_loc54_];
                     _loc37_.var_58[_loc49_] = new class_148(_loc51_,_loc53_);
                  }
                  else
                  {
                     _loc37_.var_58[_loc49_] = new class_148(null,0);
                  }
                  _loc49_++;
               }
            }
         }
         _loc38_ = this.var_1.GetEntFromID(_loc2_);
         if(Boolean(_loc38_) && _loc38_.bIAmValid)
         {
            _loc55_ = int(this.var_1.entities.indexOf(_loc38_));
            if(_loc55_ != -1)
            {
               this.var_1.entities.splice(_loc55_,1);
            }
            _loc38_.DestroyEntity(false);
         }
         _loc36_ = Game.method_233(_loc28_);
         _loc39_ = _loc16_ ? class_14.var_224[_loc16_] : null;
         _loc40_ = _loc39_ ? new class_87(this.var_1,_loc39_,_loc17_,0,0) : null;
         _loc41_ = new Vector.<class_87>(class_7.const_684,true);
         _loc42_ = _loc19_ ? class_14.var_224[_loc19_] : null;
         if(_loc42_)
         {
            _loc41_[class_7.const_220] = new class_87(this.var_1,_loc42_,_loc20_,0,0);
         }
         _loc43_ = _loc21_ ? class_14.var_224[_loc21_] : null;
         if(_loc43_)
         {
            _loc41_[class_7.const_199] = new class_87(this.var_1,_loc43_,_loc22_,0,0);
         }
         _loc44_ = _loc23_ ? class_14.var_224[_loc23_] : null;
         if(_loc44_)
         {
            _loc41_[class_7.const_187] = new class_87(this.var_1,_loc44_,_loc24_,0,0);
         }
         _loc45_ = _loc25_ ? class_14.var_419[_loc25_] : null;
         if(_loc12_ != Entity.PLAYER)
         {
            _loc73_ = this.method_1828(_loc2_,_loc3_,_loc8_,_loc5_,_loc6_,_loc29_,_loc11_);
         }
         if(_loc73_)
         {
            _loc46_ = _loc73_;
            _loc74_ = true;
            _loc46_.id = _loc2_;
            _loc46_.cue = this.var_1.level.var_1046[_loc11_];
            _loc46_.team = _loc8_;
            _loc46_.summonerId = _loc29_;
            _loc46_.var_99 = _loc31_;
            _loc46_.physPosX = _loc5_;
            _loc46_.physPosY = _loc6_;
            _loc46_.startPhysPosX = _loc5_;
            _loc46_.startPhysPosY = _loc6_;
            _loc46_.appearPosX = _loc46_.physPosX;
            _loc46_.appearPosY = _loc46_.physPosY + _loc46_.yOffsetToSimulateZ + this.var_1.var_776;
         }
         else
         {
            _loc46_ = new Entity(this.var_1,_loc3_,this.var_1.level.var_1046[_loc11_],_loc5_,_loc6_,Entity.REMOTE | _loc12_,_loc8_,_loc2_,_loc32_,_loc29_,_loc31_,_loc37_,_loc36_,_loc41_,_loc40_,_loc45_);
         }
         _loc46_.var_38.var_914 = _loc5_;
         _loc46_.var_38.var_950 = _loc6_;
         _loc46_.var_38.var_1794 = _loc7_;
         _loc46_.bLeft = _loc34_;
         _loc46_.entState = _loc33_;
         _loc46_.bUntargetable = _loc15_;
         _loc46_.var_1958 = _loc26_;
         _loc46_.var_1879 = _loc27_;
         if(_loc12_ != Entity.PLAYER)
         {
            _loc46_.method_511(_loc9_);
         }
         if(_loc46_.entState == Entity.const_399)
         {
            _loc46_.BeginSleep();
         }
         else if(_loc46_.entState == Entity.const_467)
         {
            _loc46_.BeginDrama();
         }
         if(_loc10_)
         {
            _loc46_.behaviorSpeedMod = _loc10_ * VELOCITY_DEFLATE;
            _loc46_.RecalculateSpeed();
         }
         _loc46_.mEquipMount = _loc18_ ? class_14.var_464[_loc18_] : null;
         _loc46_.var_38.var_1667 = _loc7_ != 0;
         _loc46_.gfx.m_TheDO.visible = !_loc46_.var_38.var_1667;
         _loc47_ = param1.method_45();
         _loc48_ = param1.method_4();
         _loc49_ = 0;
         while(_loc49_ < _loc48_)
         {
            _loc56_ = param1.method_4();
            _loc57_ = param1.method_4();
            _loc58_ = param1.method_4();
            _loc59_ = param1.method_4();
            _loc60_ = param1.method_4();
            _loc61_ = class_14.buffTypes[_loc56_];
            _loc62_ = param1.method_11();
            _loc64_ = new Vector.<Number>();
            if(_loc62_)
            {
               _loc65_ = new Vector.<class_140>();
               _loc66_ = param1.method_4();
               _loc67_ = 0;
               while(_loc67_ < _loc66_)
               {
                  _loc63_ = param1.method_4();
                  _loc68_ = param1.method_4();
                  _loc69_ = 0;
                  while(_loc69_ < _loc68_)
                  {
                     _loc71_ = param1.method_560();
                     _loc64_.push(_loc71_);
                     _loc69_++;
                  }
                  _loc70_ = new class_140(_loc63_,_loc64_);
                  _loc65_.push(_loc70_);
                  _loc67_++;
               }
            }
            if(_loc61_)
            {
               _loc46_.combatState.method_522(_loc61_,_loc57_,_loc58_,_loc60_,_loc59_,_loc65_);
            }
            _loc49_++;
         }
         _loc46_.currHP -= _loc47_;
         if(_loc46_.id == this.var_1.clientEntID)
         {
            this.var_1.method_184(_loc46_.currHP);
         }
         if(!_loc74_)
         {
            this.var_1.entities.push(_loc46_);
         }
         _loc46_.var_38.var_1792 = this.var_1.mTimeThisTick;
         if(DevSettings.flags & DevSettings.DEVFLAG_OUTLINE_REMOTE_ENTS)
         {
            _loc46_.gfx.m_TheDO.filters = [new GlowFilter(4294637596)];
         }
         if(Boolean(DevSettings.flags & DevSettings.DEVFLAG_SHOWENTITYGHOST) && _loc46_.id >= 1000000000)
         {
            _loc46_.gfx.m_TheDO.filters = [new GlowFilter(4278255411)];
            _loc46_.gfx.m_TheDO.alpha = 0.5;
         }
         if(_loc46_.entType.entName.indexOf("ShadowLegion") == 0)
         {
            _loc72_ = this.var_1.GetEntFromID(_loc46_.summonerId);
            if(_loc72_)
            {
               _loc46_.entType.gfxType = _loc72_.entType.method_60();
               _loc46_.ResetEntType(_loc46_.entType);
               _loc46_.bLeft = _loc72_.bLeft;
            }
            _loc46_.var_997 = true;
         }
         if(_loc14_)
         {
            if(!_loc74_)
            {
               _loc46_.method_1646();
            }
         }
         else if(_loc13_)
         {
            if(!_loc74_)
            {
               _loc46_.method_1273();
            }
         }
      }
      
      public function ReceiveAbilityResearchDone(param1:Packet) : void
      {
         var _loc2_:int = 0;
         _loc2_ = int(param1.method_6(class_10.const_83));
         if(_loc2_)
         {
            this.var_1.mAbilityBook.ReceiveAbilityResearchDone(_loc2_);
         }
      }
      
      public function method_1914(param1:Packet) : void
      {
         var _loc2_:int = 0;
         var _loc3_:Entity = null;
         var _loc4_:String = null;
         var _loc5_:class_118 = null;
         var _loc6_:uint = 0;
         _loc2_ = int(param1.method_4());
         _loc3_ = this.var_1.GetEntFromID(_loc2_);
         if(!_loc3_)
         {
            return;
         }
         _loc4_ = _loc3_.mMasterClass;
         _loc5_ = _loc3_.var_85;
         _loc6_ = 0;
         while(_loc6_ < class_118.const_43)
         {
            if(param1.method_11())
            {
               var _loc7_:uint = class_118.method_277(_loc6_);
               var _loc8_:uint = 1;
               var _loc9_:uint = param1.method_6(class_118.const_127);
               _loc8_ = 0 + param1.method_6(0);
               var _loc10_:class_22 = class_14.var_368[_loc4_][0];
               _loc5_.var_58[_loc6_] = new class_148(null,0);
            }
            else
            {
               _loc5_.var_58[_loc6_] = new class_148(null,0);
            }
            _loc6_++;
         }
         if(_loc3_ == this.var_1.clientEnt)
         {
            if(this.var_1.var_1922)
            {
               _loc3_.ResetEntType(_loc3_.entType);
               this.var_1.var_1922 = false;
               this.var_1.bWaitingForChangeMasterClassResponse = false;
            }
         }
         else
         {
            _loc3_.ResetEntType(_loc3_.entType);
         }
      }
      
      public function method_1545(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:Entity = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_4();
         _loc4_ = this.var_1.GetEntFromID(_loc2_);
         if(_loc4_)
         {
            var _loc5_:PowerType = class_14.powerTypes[_loc3_];
            if(Boolean(_loc5_) && false)
            {
               _loc4_.combatState.var_2122 = true;
            }
         }
      }
      
      public function method_1172(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:String = null;
         var _loc5_:Entity = null;
         var _loc6_:String = null;
         var _loc7_:class_9 = null;
         var _loc8_:class_9 = null;
         var _loc9_:String = null;
         var _loc10_:String = null;
         _loc2_ = param1.method_4();
         _loc3_ = param1.method_6(Game.const_209);
         _loc5_ = this.var_1.GetEntFromID(_loc2_);
         if(_loc5_)
         {
            _loc4_ = _loc5_.mMasterClass;
            _loc6_ = Game.method_233(_loc3_);
            if(_loc6_)
            {
               _loc5_.mMasterClass = _loc6_;
               if(_loc5_.id == this.var_1.clientEntID)
               {
                  if(_loc5_.mMasterClass == "frostwarden")
                  {
                     _loc5_.var_31 = _loc5_.combatState.var_1660;
                  }
                  else
                  {
                     _loc5_.var_31 = 0;
                  }
                  this.var_1.method_114(_loc5_.var_31);
                  if(this.var_1.mMasterClassTower)
                  {
                     this.var_1.mMasterClassTower.ClearResearch();
                  }
                  this.var_1.screenSpellbook.Refresh();
                  this.var_1.screenClassTowers.Refresh();
                  this.var_1.screenHudTop.Refresh();
                  _loc7_ = this.var_1.mBuildingInfo.GetBuildingByMasterClass(_loc5_.mMasterClass);
                  _loc8_ = this.var_1.mBuildingInfo.GetBuildingByMasterClass(_loc4_);
                  if(_loc7_.rank == 0)
                  {
                     this.var_1.mBuildingInfo.method_382(_loc5_.mMasterClass,1);
                     _loc7_ = this.var_1.mBuildingInfo.GetBuildingByMasterClass(_loc5_.mMasterClass);
                  }
                  _loc9_ = "a_Upgrade_Tower";
                  if(_loc8_)
                  {
                     _loc9_ = _loc8_.var_266;
                  }
                  this.var_1.var_163["Scaffolding"] = this.var_1.mBuildingInfo.mWorkerBuildingID;
                  this.var_1.var_163[_loc7_.type] = _loc7_;
                  _loc10_ = _loc7_.var_266;
                  this.var_1.level.method_506(_loc10_);
                  this.var_1.level.method_194();
                  this.var_1.mAbilityBook.DefaultMasterRanks(_loc5_.var_85,_loc5_.mMasterClass);
               }
               _loc5_.ResetEntType(_loc5_.entType);
               if(_loc5_.id == this.var_1.clientEntID)
               {
                  this.var_1.var_1922 = true;
               }
            }
         }
      }
      
      public function method_1204(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(class_9.const_129);
         if(this.var_1.mBuildingInfo)
         {
            this.var_1.mBuildingInfo.method_469();
            this.var_1.mBuildingInfo.mStatus = class_105.const_521;
         }
      }
      
      public function method_2074(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         _loc2_ = param1.method_6(class_1.const_254);
         _loc3_ = param1.method_4();
         this.var_1.mMagicForgeStatus.status = class_111.const_286;
         this.var_1.mMagicForgeStatus.primary = _loc2_;
         this.var_1.mMagicForgeStatus.endtime = _loc3_;
         this.var_1.screenForge.Refresh();
      }
      
      public function method_1655(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:uint = 0;
         _loc2_ = param1.method_6(class_1.const_254);
         _loc3_ = param1.method_91();
         _loc4_ = param1.method_91();
         _loc5_ = param1.method_6(class_64.const_499);
         _loc6_ = 0;
         _loc7_ = 0;
         if(_loc5_)
         {
            _loc7_ = param1.method_6(class_64.const_218);
            _loc6_ = param1.method_6(class_111.const_432);
         }
         this.var_1.mMagicForgeStatus.secondary = _loc7_;
         this.var_1.mMagicForgeStatus.usedlist = _loc6_;
         this.var_1.mMagicForgeStatus.status = class_111.const_264;
         this.var_1.mMagicForgeStatus.var_2675 = _loc3_;
         this.var_1.mMagicForgeStatus.var_2316 = _loc4_;
         this.var_1.mMagicForgeStatus.var_8 = _loc5_;
         this.var_1.mMagicForgeStatus.primary = _loc2_;
         if(this.var_1.screenForge.mbVisible)
         {
            this.var_1.screenForge.Hide();
            if(this.var_1.var_996.mbVisible)
            {
               this.var_1.var_996.Refresh();
            }
            else
            {
               this.var_1.var_996.Display();
            }
         }
         else if(!this.var_1.var_996.mbVisible)
         {
            this.var_1.screenNotification.ShowNotification(class_46.const_211,"Your Charm is waiting at the Forge");
         }
      }
      
      public function method_1099(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(class_66.const_571);
         if(this.var_1.mMasterClassTower)
         {
            this.var_1.mMasterClassTower.mStatus = class_66.const_534;
            this.var_1.mMasterClassTower.method_469();
         }
      }
      
      public function method_1024(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:class_9 = null;
         var _loc8_:class_9 = null;
         var _loc9_:String = null;
         var _loc10_:String = null;
         _loc2_ = param1.method_6(class_9.const_129);
         _loc3_ = param1.method_6(class_9.const_28);
         _loc4_ = param1.method_6(class_9.const_129);
         _loc5_ = param1.method_6(class_9.const_28);
         _loc6_ = param1.method_6(class_9.const_129);
         _loc7_ = class_9.method_216(_loc2_,_loc3_);
         _loc8_ = class_9.method_216(_loc4_,_loc5_);
         this.var_1.var_163["Scaffolding"] = _loc6_;
         _loc9_ = _loc7_.var_266;
         _loc10_ = _loc8_.var_266;
         if(_loc9_ != _loc10_)
         {
            this.var_1.level.method_506(_loc10_);
         }
         this.var_1.level.method_194();
      }
      
      public function method_1499(param1:Packet) : void
      {
         this.var_1.screenUpgrading.Refresh();
         this.var_1.screenClassTowers.Refresh();
         this.var_1.screenForge.Refresh();
         this.var_1.screenTome.Refresh();
         this.var_1.screenBarn.Refresh();
      }
      
      public function method_1699(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:Vector.<uint> = null;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         _loc2_ = param1.method_6(class_16.const_167);
         _loc3_ = new Vector.<uint>();
         _loc4_ = 0;
         while(_loc4_ < _loc2_)
         {
            _loc6_ = param1.method_6(class_16.const_167);
            _loc3_.push(_loc6_);
            _loc4_++;
         }
         _loc5_ = param1.method_4();
         this.var_1.mEggPetInfo.method_976(_loc3_);
         this.var_1.mEggPetInfo.method_891(_loc5_);
         this.var_1.mEggPetInfo.mbAskingForEggs = false;
         if(this.var_1.screenBarn)
         {
            this.var_1.screenBarn.Refresh();
         }
      }
      
      public function method_1555(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(class_16.const_167);
         if(this.var_1.mEggPetInfo)
         {
            this.var_1.mEggPetInfo.mEggStatus = class_81.const_319;
            if(!this.var_1.screenBarn.mbVisible)
            {
               this.var_1.mEggPetInfo.method_1133();
            }
         }
      }
      
      public function method_1893(param1:Packet) : void
      {
         var _loc2_:uint = param1.method_6(class_7.const_19);
         var _loc3_:uint = param1.method_4();
         if(this.var_1.mEggPetInfo)
         {
            this.var_1.mEggPetInfo.mPetTrainingStatus = class_81.const_474;
            if(!this.var_1.screenBarn.mbVisible)
            {
               this.var_1.mEggPetInfo.method_1321();
            }
         }
      }
      
      public function method_1816(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         _loc2_ = param1.method_4();
         this.var_1.mEggPetInfo.method_1937(_loc2_);
         if(Boolean(this.var_1.screenArmory) && this.var_1.screenArmory.method_1562())
         {
            this.var_1.screenArmory.Refresh();
         }
         this.var_1.screenFeedPet.Refresh();
      }
      
      public function method_1711(param1:Packet) : void
      {
         var _loc2_:Vector.<GearType> = null;
         var _loc3_:uint = 0;
         var _loc4_:uint = 0;
         var _loc5_:uint = 0;
         var _loc6_:uint = 0;
         var _loc7_:String = null;
         var _loc8_:GearType = null;
         _loc2_ = new Vector.<GearType>();
         _loc3_ = param1.method_4();
         _loc4_ = 0;
         while(_loc4_ < _loc3_)
         {
            _loc5_ = param1.method_6(GearType.GEARTYPE_BITSTOSEND);
            _loc6_ = param1.method_6(GearType.const_176);
            _loc7_ = Game.method_110(_loc5_,_loc6_);
            _loc8_ = class_14.var_421[_loc7_];
            if(_loc8_)
            {
               _loc2_.push(_loc8_);
            }
            _loc4_++;
         }
         if(this.var_1.level)
         {
            this.var_1.level.var_811 = _loc2_;
         }
      }
      
      public function method_1175(param1:Packet) : void
      {
         if(this.var_1.clientEnt)
         {
            this.var_1.clientEnt.method_1828();
         }
      }
      
      public function method_1044(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         _loc2_ = param1.method_6(Game.const_390);
         this.var_1.var_1868 = true;
         this.var_1.var_2878 = (_loc2_ + 1) % Game.const_1267;
      }
      
      public function method_1834(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:Packet = null;
         _loc2_ = param1.method_6(Game.const_794);
         _loc3_ = param1.method_4();
         _loc4_ = new Packet(LinkUpdater.const_969);
         _loc4_.method_9(this.var_1.clientEnt.meleeDamage);
         _loc4_.method_9(this.var_1.clientEnt.magicDamage);
         _loc4_.method_9(this.var_1.clientEnt.maxHP);
         _loc4_.method_20(Game.const_794,_loc2_);
         _loc4_.method_9(_loc3_);
         this.var_1.serverConn.SendPacket(_loc4_);
      }
      
      public function method_1203(param1:uint, param2:String, param3:String) : Boolean
      {
         var _loc4_:Boolean = false;
         var _loc5_:Friend = null;
         var _loc6_:Packet = null;
         _loc4_ = false;
         if(!this.var_1.CanSendPacket())
         {
            return false;
         }
         if(this.var_1.bIgnoreStrangerInvites && param3.indexOf("has invited you to join a party") >= 0)
         {
            _loc4_ = true;
            for each(_loc5_ in this.var_1.friendList)
            {
               if(_loc5_.charName == param2 && !_loc5_.var_276)
               {
                  _loc4_ = false;
                  break;
               }
            }
            if(_loc4_)
            {
               for each(_loc5_ in this.var_1.var_124)
               {
                  if(_loc5_.charName == param2)
                  {
                     _loc4_ = false;
                     break;
                  }
               }
            }
         }
         if(_loc4_)
         {
            _loc6_ = new Packet(LinkUpdater.PKTTYPE_QUERYMESSAGE_ANSWER);
            _loc6_.method_9(param1);
            _loc6_.method_26(param2);
            _loc6_.method_15(false);
            this.var_1.serverConn.SendPacket(_loc6_);
         }
         return _loc4_;
      }
      
      public function method_1620(param1:Packet) : void
      {
         if(!this.var_1.screenBarn.mbVisible)
         {
            this.var_1.screenNotification.ShowNotification(class_46.const_772,"You have a set of new Eggs in your Hatchery!");
         }
      }
      
      public function method_1898(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:* = null;
         var _loc4_:String = null;
         var _loc5_:String = null;
         var _loc6_:uint = 0;
         _loc2_ = param1.method_4();
         _loc4_ = "Warning: Server maintenance will begin in ";
         _loc5_ = "";
         if(_loc2_ > 60)
         {
            _loc6_ = _loc2_ / 60;
            if(_loc6_ == 1)
            {
               _loc3_ = _loc6_ + " minute. ";
            }
            else
            {
               _loc3_ = _loc6_ + " minutes. ";
            }
         }
         else if(_loc2_ == 1)
         {
            _loc3_ = _loc2_ + " second. ";
         }
         else
         {
            _loc3_ = _loc2_ + " seconds. ";
         }
         this.var_1.screenChat.ReadUnsafeStatusText(_loc4_ + _loc3_ + _loc5_,"Admin");
      }
      
      public function method_1654(param1:Packet) : void
      {
         var _loc2_:String = null;
         _loc2_ = param1.method_13();
         this.var_1.screenChat.ReadUnsafeStatusText(_loc2_,"Admin");
      }
      
      public function method_1950(param1:Packet) : void
      {
         var _loc2_:String = null;
         var _loc3_:String = null;
         var _loc4_:String = null;
         var _loc5_:String = null;
         var _loc6_:uint = 0;
         _loc2_ = param1.method_13();
         _loc3_ = param1.method_13();
         _loc4_ = param1.method_13();
         _loc5_ = param1.method_13();
         _loc6_ = param1.method_4();
         this.var_1.mNewsData.method_690(_loc2_,_loc3_,_loc4_,_loc5_,_loc6_);
         this.var_1.var_1828.Refresh();
      }
      
      public function method_1846(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:Boolean = false;
         _loc2_ = param1.method_6(class_15.const_300);
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_11();
         this.var_1.mLockboxData.method_1310(_loc2_,_loc3_,_loc4_);
         this.var_1.screenLockBox.Refresh();
      }
      
      public function method_1622(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:String = null;
         var _loc5_:class_18 = null;
         _loc2_ = param1.method_6(class_18.var_1846);
         _loc3_ = param1.method_6(class_18.var_1776);
         if(param1.method_11())
         {
            _loc4_ = param1.method_13();
         }
         _loc5_ = class_18.method_1084(_loc2_,_loc3_);
         this.var_1.screenLockBox.method_1148(_loc4_,_loc5_);
      }
      
      public function method_1961(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:Boolean = false;
         var _loc4_:class_64 = null;
         var _loc5_:class_1 = null;
         var _loc6_:String = null;
         _loc2_ = param1.method_6(class_64.const_101);
         _loc3_ = param1.method_11();
         _loc4_ = class_64.method_56(_loc2_);
         if(!_loc4_)
         {
            return;
         }
         _loc5_ = _loc4_.var_13;
         if(!_loc5_)
         {
            return;
         }
         if(!_loc3_)
         {
            _loc6_ = _loc4_.var_8 == class_64.const_196 ? "L" : (_loc4_.var_8 == class_64.const_180 ? "R" : "M");
            this.var_1.screenNotification.ShowNotification(class_46.const_211,_loc4_.method_49(),_loc6_,true,null,null,_loc4_);
         }
         this.var_1.GainCharm(_loc4_,false);
      }
      
      public function method_1831(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:Boolean = false;
         var _loc4_:class_21 = null;
         _loc2_ = param1.method_6(class_21.const_50);
         _loc3_ = param1.method_11();
         _loc4_ = class_14.var_194[_loc2_];
         if(!_loc4_)
         {
            return;
         }
         this.var_1.method_1134(_loc4_,_loc3_);
      }
      
      public function method_1779(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:Boolean = false;
         var _loc5_:class_3 = null;
         _loc2_ = param1.method_6(class_3.const_69);
         _loc3_ = param1.method_4();
         _loc4_ = param1.method_11();
         _loc5_ = class_14.var_419[_loc2_];
         if(!_loc5_)
         {
            return;
         }
         this.var_1.method_1202(_loc5_,_loc3_,_loc4_);
      }
      
      public function method_1091(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         var _loc3_:uint = 0;
         var _loc4_:class_3 = null;
         var _loc5_:uint = 0;
         var _loc6_:class_103 = null;
         var _loc7_:Entity = null;
         var _loc8_:Boolean = false;
         var _loc9_:Boolean = false;
         var _loc10_:Packet = null;
         var _loc11_:uint = 0;
         _loc2_ = param1.method_6(class_3.const_69);
         _loc3_ = param1.method_4();
         _loc4_ = class_14.var_419[_loc2_];
         if(!_loc4_)
         {
            return;
         }
         _loc5_ = 0;
         _loc6_ = this.var_1.mOwnedConsumables[_loc2_];
         if(!_loc6_)
         {
            _loc6_ = new class_103(_loc4_,_loc3_);
            this.var_1.mConsumablesList.push(_loc6_);
            this.var_1.mOwnedConsumables[_loc2_] = _loc6_;
         }
         else
         {
            _loc5_ = _loc6_.stackCount;
            _loc6_.stackCount = _loc3_;
         }
         _loc7_ = this.var_1.clientEnt;
         _loc8_ = _loc6_.method_1996(_loc5_);
         if(_loc7_ && _loc6_.consumableType.var_427 && _loc8_)
         {
            _loc9_ = false;
            if(!_loc7_.mNextPotion)
            {
               _loc9_ = true;
               _loc7_.method_190(null);
               _loc10_ = new Packet(LinkUpdater.const_252);
               _loc10_.method_9(_loc7_.id);
               _loc10_.method_20(class_3.const_69,0);
               this.var_1.serverConn.SendPacket(_loc10_);
            }
            else if(_loc7_.mNextPotion != _loc7_.mCurrPotion)
            {
               _loc9_ = true;
               _loc7_.method_190(_loc7_.mNextPotion);
               _loc10_ = new Packet(LinkUpdater.const_252);
               _loc10_.method_9(_loc7_.id);
               _loc10_.method_20(class_3.const_69,_loc7_.mNextPotion.consumableID);
               this.var_1.serverConn.SendPacket(_loc10_);
            }
            if(!_loc6_.stackCount)
            {
               if(!_loc9_)
               {
                  this.var_1.screenNotification.ShowNotification(class_46.const_353,"You have run out of " + _loc4_.displayName + "!","M",true,null,_loc6_.consumableType.iconName);
                  this.var_1.QueuePotion(null);
                  _loc7_.method_190(null);
                  _loc10_ = new Packet(LinkUpdater.const_252);
                  _loc10_.method_9(_loc7_.id);
                  _loc10_.method_20(class_3.const_69,0);
                  this.var_1.serverConn.SendPacket(_loc10_);
               }
            }
         }
         if(!_loc6_.stackCount)
         {
            _loc11_ = 0;
            while(_loc11_ < this.var_1.mConsumablesList.length)
            {
               if(this.var_1.mConsumablesList[_loc11_].consumableType == _loc4_)
               {
                  this.var_1.mConsumablesList[_loc11_] = null;
                  this.var_1.mConsumablesList.splice(_loc11_,1);
                  break;
               }
               _loc11_++;
            }
            this.var_1.mOwnedConsumables[_loc2_] = null;
            delete this.var_1.mOwnedConsumables[_loc2_];
            _loc6_.method_786();
         }
         this.var_1.screenArmory.Refresh();
         if(_loc4_.type == "ForgeXP")
         {
            this.var_1.screenForge.Refresh();
         }
         this.var_1.screenHudTopRight.Refresh();
      }
      
      public function method_1015(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         _loc2_ = param1.method_4();
         this.var_1.mLockboxData.mRoyalSigils -= _loc2_;
         this.var_1.screenRoyalSigilStore.Refresh();
      }
      
      public function method_1694(param1:Packet) : void
      {
         var _loc2_:uint = 0;
         _loc2_ = param1.method_4();
         this.var_1.mLockboxData.mRoyalSigils += _loc2_;
         this.var_1.mLockboxData.method_1966(_loc2_);
      }
   }
}

